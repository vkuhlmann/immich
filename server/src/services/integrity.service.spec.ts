import { Readable } from 'node:stream';
import { IntegrityReport, JobStatus } from 'src/enum.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(IntegrityService.name, () => {
  let sut: IntegrityService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(IntegrityService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('S3 outages', () => {
    const path = 's3://immich-test/immich/originals/user/photo.jpg';
    const unavailable = Object.assign(new Error('S3 unavailable'), { $metadata: { httpStatusCode: 503 } });

    it('does not report inaccessible objects as missing', async () => {
      mocks.storage.stat.mockRejectedValue(unavailable);
      await expect(
        sut.handleMissingFiles({ items: [{ path, assetId: 'asset-id', fileAssetId: null, reportId: null }] }),
      ).rejects.toThrow('S3 unavailable');
      expect(mocks.integrityReport.create).not.toHaveBeenCalled();
    });

    it('reports genuinely missing objects', async () => {
      mocks.storage.stat.mockRejectedValue(
        Object.assign(new Error('Not found'), { $metadata: { httpStatusCode: 404 } }),
      );
      expect(
        await sut.handleMissingFiles({ items: [{ path, assetId: 'asset-id', fileAssetId: null, reportId: null }] }),
      ).toBe(JobStatus.Success);
      expect(mocks.integrityReport.create).toHaveBeenCalledWith([
        { path, assetId: 'asset-id', fileAssetId: null, type: IntegrityReport.MissingFile },
      ]);
    });

    it('preserves existing checksum reports when the bucket is unavailable', async () => {
      const stream = new Readable({
        read() {
          stream.destroy(unavailable);
        },
      });
      mocks.storage.createPlainReadStream.mockReturnValue(stream);
      await expect(
        sut.handleChecksumRefresh({ items: [{ path, reportId: 'report-id', checksum: '1234' }] }),
      ).rejects.toThrow('S3 unavailable');
      expect(mocks.integrityReport.deleteByIds).not.toHaveBeenCalled();
    });
  });

  describe('handleUntrackedFiles', () => {
    const decomposedPath = '/data/upload/upload/user-id/Cafe\u{301}.jpg';
    const composedPath = '/data/upload/upload/user-id/Caf\u{E9}.jpg';

    beforeEach(() => {
      mocks.integrityReport.getAssetPathsByPaths.mockResolvedValue([]);
      mocks.integrityReport.getPersonThumbnailPathsByPaths.mockResolvedValue([]);
    });

    it.each([
      { scannedPath: decomposedPath, storedPath: composedPath },
      { scannedPath: composedPath, storedPath: decomposedPath },
    ])(
      'should not report a tracked asset whose path differs only by unicode normalization',
      async ({ scannedPath, storedPath }) => {
        mocks.integrityReport.getAssetPathsByPaths.mockResolvedValue([
          { originalPath: storedPath, encodedVideoPath: null },
        ]);

        await sut.handleUntrackedFiles({ type: 'asset', paths: [scannedPath] });

        expect(mocks.integrityReport.getAssetPathsByPaths).toHaveBeenCalledWith(
          expect.arrayContaining([decomposedPath, composedPath]),
        );
        expect(mocks.integrityReport.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('handleUntrackedRefresh', () => {
    beforeEach(() => {
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);
    });

    it('should delete a report whose path is now referenced by an asset', async () => {
      const path = '/data/upload/admin/ab/asset.mov';
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([{ path }] as never);

      await sut.handleUntrackedRefresh({ items: [{ reportId: 'report-id', path }] });

      expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['report-id']);
      expect(mocks.storage.stat).not.toHaveBeenCalled();
    });

    it('should keep a report whose path is still untracked and present on disk', async () => {
      mocks.storage.stat.mockResolvedValue({} as never);

      await sut.handleUntrackedRefresh({ items: [{ reportId: 'report-id', path: '/data/upload/orphan.mov' }] });

      expect(mocks.integrityReport.deleteByIds).not.toHaveBeenCalled();
    });

    it('should not query for references when the batch is empty', async () => {
      await sut.handleUntrackedRefresh({ items: [] });

      expect(mocks.integrityReport.getTrackedPaths).not.toHaveBeenCalled();
      expect(mocks.integrityReport.deleteByIds).not.toHaveBeenCalled();
    });
  });

  describe('deleteIntegrityReport', () => {
    it('should not unlink a path that is now tracked', async () => {
      const path = '/data/upload/admin/ab/asset.mov';
      mocks.integrityReport.getById.mockResolvedValue({ path } as never);
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([{ path }] as never);

      await sut.deleteIntegrityReport('user-id', 'report-id');

      expect(mocks.storage.unlink).not.toHaveBeenCalled();
      expect(mocks.integrityReport.deleteById).toHaveBeenCalledWith('report-id');
    });
  });

  describe('handleDeleteIntegrityReports', () => {
    it('should unlink only paths that are still untracked', async () => {
      const tracked = '/data/upload/admin/ab/asset.mov';
      const untracked = '/data/upload/orphan.mov';
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([{ path: tracked }] as never);
      mocks.storage.unlink.mockResolvedValue();

      await sut.handleDeleteIntegrityReports({
        reports: [
          { id: 'tracked-report', path: tracked },
          { id: 'untracked-report', path: untracked },
        ] as never,
      });

      expect(mocks.storage.unlink).toHaveBeenCalledExactlyOnceWith(untracked);
      expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['tracked-report', 'untracked-report']);
    });
  });

  describe('handleDeleteAllIntegrityReports', () => {
    beforeEach(() => {
      mocks.integrityReport.streamIntegrityReportsByProperty.mockReturnValue((function* () {})() as never);
    });

    it('should query all property types when no type specified', async () => {
      await sut.handleDeleteAllIntegrityReports({});

      expect(mocks.integrityReport.streamIntegrityReportsByProperty).toHaveBeenCalledWith(undefined, undefined);
      expect(mocks.integrityReport.streamIntegrityReportsByProperty).toHaveBeenCalledWith('assetId', undefined);
      expect(mocks.integrityReport.streamIntegrityReportsByProperty).toHaveBeenCalledWith('fileAssetId', undefined);
    });
  });
});
