import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { VideoProcessor } from '../videos/processing/video.processor';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile and provide the video processor', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue({ add: jest.fn() })
      .compile();

    expect(module.get(VideoProcessor, { strict: false })).toBeInstanceOf(
      VideoProcessor,
    );
    await module.close();
  }, 30000);
});
