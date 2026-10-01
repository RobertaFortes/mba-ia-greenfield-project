import {
  NoVideoStreamError,
  parseProbeOutput,
  type ProbeOutput,
} from './probe-parser.util';

const withAudio: ProbeOutput = {
  format: {
    duration: '3.000000',
    bit_rate: '69000',
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 320,
      height: 240,
      avg_frame_rate: '25/1',
      r_frame_rate: '25/1',
      duration: '3.000000',
      disposition: { attached_pic: 0 },
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
};

describe('parseProbeOutput', () => {
  it('should extract the metadata of a video with audio', () => {
    expect(parseProbeOutput(withAudio)).toEqual({
      durationSeconds: 3,
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: 'aac',
      bitrate: 69000,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      fps: 25,
      raw: withAudio,
    });
  });

  it('should report a null audio codec when there is no audio stream', () => {
    const silent: ProbeOutput = {
      ...withAudio,
      streams: [withAudio.streams![0]],
    };

    expect(parseProbeOutput(silent).audioCodec).toBeNull();
  });

  it('should compute fractional frame rates such as 30000/1001', () => {
    const ntsc: ProbeOutput = {
      ...withAudio,
      streams: [{ ...withAudio.streams![0], avg_frame_rate: '30000/1001' }],
    };

    expect(parseProbeOutput(ntsc).fps).toBeCloseTo(29.97, 2);
  });

  it('should fall back to r_frame_rate when avg_frame_rate is unknown (0/0)', () => {
    const unknown: ProbeOutput = {
      ...withAudio,
      streams: [
        {
          ...withAudio.streams![0],
          avg_frame_rate: '0/0',
          r_frame_rate: '24/1',
        },
      ],
    };

    expect(parseProbeOutput(unknown).fps).toBe(24);
  });

  it('should use the stream duration when the container has none', () => {
    const noFormatDuration: ProbeOutput = {
      format: {},
      streams: [{ ...withAudio.streams![0], duration: '7.5' }],
    };

    expect(parseProbeOutput(noFormatDuration).durationSeconds).toBe(7.5);
  });

  it('should throw NoVideoStreamError for an audio-only file', () => {
    expect(() =>
      parseProbeOutput({
        format: { duration: '3' },
        streams: [{ codec_type: 'audio', codec_name: 'aac' }],
      }),
    ).toThrow(NoVideoStreamError);
  });

  it('should ignore cover art flagged as attached_pic', () => {
    expect(() =>
      parseProbeOutput({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'mjpeg',
            disposition: { attached_pic: 1 },
          },
          { codec_type: 'audio', codec_name: 'mp3' },
        ],
      }),
    ).toThrow(NoVideoStreamError);
  });

  it('should throw NoVideoStreamError when there are no streams at all', () => {
    expect(() => parseProbeOutput({})).toThrow(NoVideoStreamError);
  });
});
