FROM node:24-alpine
WORKDIR /app
RUN npm install --omit=dev s3rver@3.7.1
COPY server/test/s3/mock-server.mjs ./mock-server.mjs
ENV MOCK_S3_HOST=0.0.0.0 MOCK_S3_PORT=4569 MOCK_S3_DIRECTORY=/data
CMD ["node", "mock-server.mjs"]
