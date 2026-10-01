import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  VideoFileTooLargeException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoQueueUnavailableException,
  VideoSizeMismatchException,
  VideoUnsupportedContentTypeException,
  VideoUploadIncompleteException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { VideoQueueService } from './video-queue.service';
import { VideosService } from './videos.service';

const MIB = 1024 ** 2;

function uniqueViolation(): QueryFailedError {
  return new QueryFailedError('INSERT', [], {
    code: '23505',
    detail: 'Key (public_id)=(abc) already exists.',
  } as unknown as Error);
}

describe('VideosService', () => {
  let service: VideosService;
  const repo = {
    create: jest.fn((fields: Partial<Video>) => ({ ...fields })),
    save: jest.fn((entity: Partial<Video>) => Promise.resolve(entity)),
    update: jest.fn(),
    delete: jest.fn(),
    findOneBy: jest.fn(),
  };
  const channels = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    abortMultipartUpload: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const queue = { enqueue: jest.fn() };
  const config = {
    uploadPartSizeBytes: 5 * MIB,
    uploadUrlExpirationSeconds: 3600,
  };
  const dto = {
    filename: 'my holiday.mov',
    content_type: 'video/quicktime',
    size_bytes: 11 * MIB,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    repo.save.mockImplementation((entity: Partial<Video>) =>
      Promise.resolve(entity),
    );
    channels.findByUserId.mockResolvedValue({ id: 'channel-1' });
    storage.createMultipartUpload.mockResolvedValue('upload-1');
    storage.presignUploadPart.mockImplementation(
      (_key: string, _id: string, part: number) =>
        Promise.resolve(`http://s/part-${part}`),
    );
    storage.abortMultipartUpload.mockResolvedValue(undefined);
    repo.update.mockResolvedValue(undefined);
    repo.delete.mockResolvedValue(undefined);
    repo.findOneBy.mockReset();
    queue.enqueue.mockReset().mockResolvedValue(undefined);
    storage.listParts.mockReset();
    storage.completeMultipartUpload.mockReset().mockResolvedValue(undefined);
    storage.headObject.mockReset();
    storage.deleteObject.mockReset().mockResolvedValue(undefined);

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        { provide: VideoQueueService, useValue: queue },
        { provide: videoConfig.KEY, useValue: config },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('initUpload', () => {
    it('should reject a user without a channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(service.initUpload('user-1', dto)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('should reject a size above 10 GiB without touching the database', async () => {
      await expect(
        service.initUpload('user-1', {
          ...dto,
          size_bytes: 10 * 1024 ** 3 + 1,
        }),
      ).rejects.toBeInstanceOf(VideoFileTooLargeException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('should reject an unsupported content type', async () => {
      await expect(
        service.initUpload('user-1', { ...dto, content_type: 'video/avi' }),
      ).rejects.toBeInstanceOf(VideoUnsupportedContentTypeException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('should create a draft, open the multipart and return one URL per part', async () => {
      const result = await service.initUpload('user-1', dto);

      expect(result).toMatchObject({
        status: VideoStatus.DRAFT,
        title: 'my holiday',
        upload_id: 'upload-1',
        part_size_bytes: 5 * MIB,
        total_parts: 3,
        url_expires_in_seconds: 3600,
      });
      expect(result.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(result.parts).toEqual([
        { part_number: 1, url: 'http://s/part-1' },
        { part_number: 2, url: 'http://s/part-2' },
        { part_number: 3, url: 'http://s/part-3' },
      ]);
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.id}/original.mov`,
        'video/quicktime',
      );
      expect(repo.update).toHaveBeenCalledWith(result.id, {
        upload_id: 'upload-1',
        part_size_bytes: 5 * MIB,
        total_parts: 3,
      });
    });

    it('should keep an explicit title and truncate a long default title to 200 characters', async () => {
      const explicit = await service.initUpload('user-1', {
        ...dto,
        title: 'Custom',
      });
      const long = await service.initUpload('user-1', {
        ...dto,
        filename: `${'a'.repeat(250)}.mp4`,
      });

      expect(explicit.title).toBe('Custom');
      expect(long.title).toHaveLength(200);
    });

    it('should retry with a new public id when the generated one collides', async () => {
      repo.save
        .mockRejectedValueOnce(uniqueViolation())
        .mockRejectedValueOnce(uniqueViolation());

      const result = await service.initUpload('user-1', dto);

      expect(repo.save).toHaveBeenCalledTimes(3);
      expect(result.status).toBe(VideoStatus.DRAFT);
    });

    it('should give up after the bounded number of public id collisions', async () => {
      repo.save.mockRejectedValue(uniqueViolation());

      await expect(service.initUpload('user-1', dto)).rejects.toBeInstanceOf(
        QueryFailedError,
      );
      expect(repo.save).toHaveBeenCalledTimes(5);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should not retry on a database error that is not a public id collision', async () => {
      repo.save.mockRejectedValue(new Error('connection lost'));

      await expect(service.initUpload('user-1', dto)).rejects.toThrow(
        'connection lost',
      );
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('should delete the draft and rethrow when storage fails after the insert', async () => {
      storage.createMultipartUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(service.initUpload('user-1', dto)).rejects.toThrow(
        'storage down',
      );
      expect(repo.delete).toHaveBeenCalledTimes(1);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should also abort the multipart when presigning fails after it was opened', async () => {
      storage.presignUploadPart.mockRejectedValue(new Error('sign failed'));

      await expect(service.initUpload('user-1', dto)).rejects.toThrow(
        'sign failed',
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original\.mov$/),
        'upload-1',
      );
      expect(repo.delete).toHaveBeenCalledTimes(1);
    });
  });

  const draft = {
    id: 'video-1',
    public_id: 'abcdefghijk',
    channel_id: 'channel-1',
    status: VideoStatus.DRAFT,
    title: 'clip',
    processing_error: null,
    upload_id: 'upload-1',
    part_size_bytes: 5 * MIB,
    total_parts: 3,
    size_bytes: 11 * MIB,
    storage_key: 'videos/video-1/original.mp4',
  };
  const allParts = [1, 2, 3].map((n) => ({ part_number: n, etag: `"e${n}"` }));

  describe('getUploadSession', () => {
    it('should answer VIDEO_NOT_FOUND for a user without channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(
        service.getUploadSession('user-1', draft.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should answer VIDEO_NOT_FOUND when the video is not in the caller channel', async () => {
      repo.findOneBy.mockResolvedValue(null);

      await expect(
        service.getUploadSession('user-1', draft.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repo.findOneBy).toHaveBeenCalledWith({
        public_id: draft.public_id,
        channel_id: 'channel-1',
      });
    });

    it('should list stored parts and presign only the missing ones for a draft', async () => {
      repo.findOneBy.mockResolvedValue(draft);
      storage.listParts.mockResolvedValue([
        { partNumber: 1, size: 5 * MIB, etag: '"e1"' },
        { partNumber: 3, size: MIB, etag: '"e3"' },
      ]);

      const result = await service.getUploadSession('user-1', draft.public_id);

      expect(result.uploaded_parts).toEqual([
        { part_number: 1, size_bytes: 5 * MIB, etag: '"e1"' },
        { part_number: 3, size_bytes: MIB, etag: '"e3"' },
      ]);
      expect(result.pending_parts).toEqual([
        { part_number: 2, url: 'http://s/part-2' },
      ]);
      expect(result).toMatchObject({
        upload_id: 'upload-1',
        total_parts: 3,
        url_expires_in_seconds: 3600,
      });
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should report a %s video with empty arrays and null upload fields',
      async (status) => {
        repo.findOneBy.mockResolvedValue({
          ...draft,
          status,
          upload_id: null,
          processing_error:
            status === VideoStatus.FAILED ? 'SIZE_MISMATCH' : null,
        });

        const result = await service.getUploadSession(
          'user-1',
          draft.public_id,
        );

        expect(result).toMatchObject({
          status,
          upload_id: null,
          part_size_bytes: null,
          total_parts: null,
          url_expires_in_seconds: null,
          uploaded_parts: [],
          pending_parts: [],
        });
        expect(storage.listParts).not.toHaveBeenCalled();
      },
    );
  });

  describe('completeUpload', () => {
    beforeEach(() => {
      repo.findOneBy.mockResolvedValue(draft);
      storage.headObject.mockResolvedValue({
        contentLength: 11 * MIB,
        contentType: 'video/mp4',
      });
    });

    it('should answer VIDEO_NOT_FOUND for a foreign video', async () => {
      repo.findOneBy.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-1', draft.public_id, { parts: allParts }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should answer VIDEO_INVALID_STATE for a %s video',
      async (status) => {
        repo.findOneBy.mockResolvedValue({ ...draft, status });

        await expect(
          service.completeUpload('user-1', draft.public_id, {
            parts: allParts,
          }),
        ).rejects.toBeInstanceOf(VideoInvalidStateException);
        expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['fewer parts than total', allParts.slice(0, 2)],
      ['a repeated part number', [allParts[0], allParts[0], allParts[1]]],
      [
        'a part number outside 1..total',
        [allParts[0], allParts[1], { part_number: 4, etag: '"e4"' }],
      ],
    ])('should reject %s as VIDEO_UPLOAD_INCOMPLETE', async (_label, parts) => {
      await expect(
        service.completeUpload('user-1', draft.public_id, { parts }),
      ).rejects.toBeInstanceOf(VideoUploadIncompleteException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it.each([
      'InvalidPart',
      'InvalidPartOrder',
      'EntityTooSmall',
      'NoSuchUpload',
    ])(
      'should map the storage error %s to VIDEO_UPLOAD_INCOMPLETE',
      async (name) => {
        storage.completeMultipartUpload.mockRejectedValue(
          Object.assign(new Error(name), { name }),
        );

        await expect(
          service.completeUpload('user-1', draft.public_id, {
            parts: allParts,
          }),
        ).rejects.toBeInstanceOf(VideoUploadIncompleteException);
        expect(repo.update).not.toHaveBeenCalled();
      },
    );

    it('should rethrow an unexpected storage error', async () => {
      storage.completeMultipartUpload.mockRejectedValue(new Error('boom'));

      await expect(
        service.completeUpload('user-1', draft.public_id, { parts: allParts }),
      ).rejects.toThrow('boom');
    });

    it('should fail the video, delete the object and answer VIDEO_SIZE_MISMATCH on a size difference', async () => {
      storage.headObject.mockResolvedValue({
        contentLength: 11 * MIB - 1,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload('user-1', draft.public_id, { parts: allParts }),
      ).rejects.toBeInstanceOf(VideoSizeMismatchException);
      expect(storage.deleteObject).toHaveBeenCalledWith(draft.storage_key);
      expect(repo.update).toHaveBeenCalledWith('video-1', {
        status: VideoStatus.FAILED,
        upload_id: null,
        processing_error: 'SIZE_MISMATCH',
      });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should move to processing, clear the upload id and enqueue the job', async () => {
      const result = await service.completeUpload('user-1', draft.public_id, {
        parts: allParts,
      });

      expect(result).toEqual({
        id: 'video-1',
        public_id: draft.public_id,
        status: VideoStatus.PROCESSING,
      });
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        draft.storage_key,
        'upload-1',
        [
          { partNumber: 1, etag: '"e1"' },
          { partNumber: 2, etag: '"e2"' },
          { partNumber: 3, etag: '"e3"' },
        ],
      );
      expect(repo.update).toHaveBeenCalledWith('video-1', {
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      expect(queue.enqueue).toHaveBeenCalledWith('video-1', draft.storage_key);
    });

    it('should fail the video with ENQUEUE_FAILED and answer 503 when the queue is down', async () => {
      queue.enqueue.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload('user-1', draft.public_id, { parts: allParts }),
      ).rejects.toBeInstanceOf(VideoQueueUnavailableException);
      expect(repo.update).toHaveBeenLastCalledWith('video-1', {
        status: VideoStatus.FAILED,
        upload_id: null,
        processing_error: 'ENQUEUE_FAILED',
      });
    });
  });

  describe('abortUpload', () => {
    beforeEach(() => {
      repo.findOneBy.mockResolvedValue(draft);
    });

    it('should answer VIDEO_NOT_FOUND for a foreign video', async () => {
      repo.findOneBy.mockResolvedValue(null);

      await expect(
        service.abortUpload('user-1', draft.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should answer VIDEO_INVALID_STATE for a %s video and leave it untouched',
      async (status) => {
        repo.findOneBy.mockResolvedValue({ ...draft, status });

        await expect(
          service.abortUpload('user-1', draft.public_id),
        ).rejects.toBeInstanceOf(VideoInvalidStateException);
        expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
        expect(repo.delete).not.toHaveBeenCalled();
      },
    );

    it('should abort the multipart upload and delete the draft', async () => {
      await service.abortUpload('user-1', draft.public_id);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        draft.storage_key,
        'upload-1',
      );
      expect(repo.delete).toHaveBeenCalledWith('video-1');
    });

    it('should still delete the draft when the multipart upload is already gone', async () => {
      storage.abortMultipartUpload.mockRejectedValue(
        Object.assign(new Error('gone'), { name: 'NoSuchUpload' }),
      );

      await service.abortUpload('user-1', draft.public_id);

      expect(repo.delete).toHaveBeenCalledWith('video-1');
    });

    it('should keep the draft when storage fails for another reason', async () => {
      storage.abortMultipartUpload.mockRejectedValue(new Error('boom'));

      await expect(
        service.abortUpload('user-1', draft.public_id),
      ).rejects.toThrow('boom');
      expect(repo.delete).not.toHaveBeenCalled();
    });
  });
});
