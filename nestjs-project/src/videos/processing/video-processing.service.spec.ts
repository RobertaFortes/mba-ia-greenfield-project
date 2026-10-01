import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import videoConfig from '../../config/video.config';
import { StorageService } from '../../storage/storage.service';
import { VideoStatus } from '../entities/video-status.enum';
import { Video } from '../entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { NoVideoStreamError } from './probe-parser.util';
import { PermanentProcessingError } from './video-processing.errors';
import {
  PROCESSING_ERROR_MAX_LENGTH,
  VideoProcessingService,
} from './video-processing.service';

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  const repo = { findOneBy: jest.fn(), update: jest.fn(), save: jest.fn() };
  const storage = { presignInternalGet: jest.fn(), putObject: jest.fn() };
  const ffmpeg = { probe: jest.fn(), extractThumbnail: jest.fn() };
  const probe = {
    durationSeconds: 3,
    width: 320,
    height: 240,
    videoCodec: 'h264',
    audioCodec: 'aac',
    bitrate: 1000,
    formatName: 'mov,mp4',
    fps: 25,
    raw: { streams: [] },
  };
  const video = {
    id: 'v1',
    status: VideoStatus.PROCESSING,
    storage_key: 'videos/v1/original.mp4',
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    repo.findOneBy.mockResolvedValue(video);
    storage.presignInternalGet.mockResolvedValue('http://storage/url');
    storage.putObject.mockResolvedValue(undefined);
    ffmpeg.probe.mockResolvedValue(probe);
    ffmpeg.extractThumbnail.mockResolvedValue(Buffer.from('jpeg'));
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: FfmpegService, useValue: ffmpeg },
        {
          provide: videoConfig.KEY,
          useValue: { processingTimeoutSeconds: 60 },
        },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
  });

  it('should leave a ready video untouched', async () => {
    repo.findOneBy.mockResolvedValue({ ...video, status: VideoStatus.READY });

    await service.process('v1');

    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it.each([VideoStatus.DRAFT, VideoStatus.FAILED])(
    'should refuse a %s video as a permanent error',
    async (status) => {
      repo.findOneBy.mockResolvedValue({ ...video, status });

      await expect(service.process('v1')).rejects.toBeInstanceOf(
        PermanentProcessingError,
      );
    },
  );

  it('should treat a missing video as a permanent error', async () => {
    repo.findOneBy.mockResolvedValue(null);

    await expect(service.process('v1')).rejects.toBeInstanceOf(
      PermanentProcessingError,
    );
  });

  it('should turn a missing video stream into a permanent error', async () => {
    ffmpeg.probe.mockRejectedValue(new NoVideoStreamError());

    await expect(service.process('v1')).rejects.toBeInstanceOf(
      PermanentProcessingError,
    );
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('should let other probe errors propagate so the job is retried', async () => {
    ffmpeg.probe.mockRejectedValue(new Error('network blip'));

    await expect(service.process('v1')).rejects.toThrow('network blip');
  });

  it('should store the thumbnail and mark the video ready with its metadata', async () => {
    await service.process('v1');

    expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith(
      'http://storage/url',
      expect.closeTo(0.3, 5),
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/v1/thumbnail.jpg',
      Buffer.from('jpeg'),
      'image/jpeg',
    );
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.READY,
        duration_seconds: 3,
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
        fps: 25,
        thumbnail_key: 'videos/v1/thumbnail.jpg',
        processed_at: expect.any(Date) as Date,
      }),
    );
  });

  it('should truncate processing_error to 500 characters', async () => {
    await service.markFailed('v1', 'x'.repeat(2000));

    const [, fields] = repo.update.mock.calls[0] as [
      unknown,
      { processing_error: string },
    ];
    expect(fields.processing_error).toHaveLength(PROCESSING_ERROR_MAX_LENGTH);
  });

  it('should only fail a video that is still processing', async () => {
    await service.markFailed('v1', 'boom');

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'v1', status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, processing_error: 'boom' },
    );
  });
});
