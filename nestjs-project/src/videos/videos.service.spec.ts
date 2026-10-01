import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  VideoFileTooLargeException,
  VideoUnsupportedContentTypeException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { VideosService } from './videos.service';

const MIB = 1024 ** 2;

function uniqueViolation(): QueryFailedError {
  return new QueryFailedError('INSERT', [], {
    code: '23505',
    detail: 'Key (public_id)=(abc) already exists.',
  } as unknown as Error);
}

describe('VideosService.initUpload', () => {
  let service: VideosService;
  const repo = {
    create: jest.fn((fields: Partial<Video>) => ({ ...fields })),
    save: jest.fn((entity: Partial<Video>) => Promise.resolve(entity)),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const channels = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    abortMultipartUpload: jest.fn(),
  };
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

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        { provide: videoConfig.KEY, useValue: config },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  it('should reject a user without a channel', async () => {
    channels.findByUserId.mockResolvedValue(null);

    await expect(service.initUpload('user-1', dto)).rejects.toBeInstanceOf(
      ChannelNotFoundException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('should reject a size above 10 GiB without touching the database', async () => {
    await expect(
      service.initUpload('user-1', { ...dto, size_bytes: 10 * 1024 ** 3 + 1 }),
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
    storage.createMultipartUpload.mockRejectedValue(new Error('storage down'));

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
