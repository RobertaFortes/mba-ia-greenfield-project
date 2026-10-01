import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ListBucketsCommand, type S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;

function bytes(size: number, fill: number): Buffer {
  return Buffer.alloc(size, fill);
}

async function putPart(url: string, body: Buffer): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  expect(response.status).toBe(200);
  return response.headers.get('etag') as string;
}

describe('StorageService (integration)', () => {
  let storage: StorageService;
  let s3: S3Client;
  let closeModule: () => Promise<void>;
  const keysToCleanUp: string[] = [];

  beforeAll(async () => {
    // Presigned URLs are fetched from inside the container, so the
    // client-facing host must be the service host here.
    process.env.S3_PUBLIC_ENDPOINT = 'http://storage:9000';
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init();
    storage = module.get(StorageService);
    s3 = module.get<S3Client>(S3_CLIENT);
    closeModule = () => module.close();
  });

  afterAll(async () => {
    for (const key of keysToCleanUp) {
      await storage.deleteObject(key);
    }
    await closeModule();
    delete process.env.S3_PUBLIC_ENDPOINT;
  });

  function newKey(name: string): string {
    const key = `test/${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`;
    keysToCleanUp.push(key);
    return key;
  }

  it('should create the bucket on init and tolerate running again', async () => {
    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets?.map((b) => b.Name)).toContain('streamtube');

    await expect(storage.ensureBucket()).resolves.toBeUndefined();
  });

  it('should complete a three-part multipart upload into an object with the summed size', async () => {
    const key = newKey('multipart.bin');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const sizes = [5 * MIB, 5 * MIB, 1 * MIB];
    const parts: { partNumber: number; etag: string }[] = [];

    for (const [index, size] of sizes.entries()) {
      const partNumber = index + 1;
      const url = await storage.presignUploadPart(
        key,
        uploadId,
        partNumber,
        60,
      );
      parts.push({
        partNumber,
        etag: await putPart(url, bytes(size, partNumber)),
      });
    }

    const listed = await storage.listParts(key, uploadId);
    expect(listed).toEqual(
      sizes.map((size, index) => ({
        partNumber: index + 1,
        size,
        etag: parts[index].etag,
      })),
    );

    await storage.completeMultipartUpload(key, uploadId, parts);
    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(11 * MIB);
    expect(head.contentType).toBe('video/mp4');
  }, 30000);

  it('should remove the upload on abort so a later listParts fails', async () => {
    const key = newKey('aborted.bin');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.listParts(key, uploadId)).rejects.toThrow();
  });

  it('should answer a ranged presigned GET with 206 and exactly the requested bytes', async () => {
    const key = newKey('ranged.bin');
    await storage.putObject(key, bytes(1000, 7), 'video/mp4');

    const url = await storage.presignGet(key, 60);
    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it('should add Content-Disposition attachment when a download filename is given', async () => {
    const key = newKey('download.bin');
    await storage.putObject(key, bytes(10, 1), 'video/mp4');

    const url = await storage.presignGet(key, 60, {
      downloadFilename: 'my video.mp4',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="my video.mp4"',
    );
  });

  it('should reject a presigned URL used after it expired', async () => {
    const key = newKey('expired.bin');
    await storage.putObject(key, bytes(10, 1), 'video/mp4');

    const url = await storage.presignGet(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const response = await fetch(url);

    expect(response.status).toBe(403);
  });

  it('should presign an internal GET on the service host that is readable from the container', async () => {
    const key = newKey('internal.bin');
    await storage.putObject(key, bytes(10, 1), 'video/mp4');

    const url = await storage.presignInternalGet(key, 60);
    const response = await fetch(url);

    expect(new URL(url).host).toBe('storage:9000');
    expect(response.status).toBe(200);
  });
});
