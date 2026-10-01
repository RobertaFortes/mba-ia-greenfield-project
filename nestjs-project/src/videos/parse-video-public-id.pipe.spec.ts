import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { generatePublicId } from './public-id.util';
import { ParseVideoPublicIdPipe } from './parse-video-public-id.pipe';

describe('ParseVideoPublicIdPipe', () => {
  const pipe = new ParseVideoPublicIdPipe();

  it('should return a valid public id unchanged', () => {
    const id = generatePublicId();

    expect(pipe.transform(id)).toBe(id);
  });

  it.each(['abc', 'abcdefghijkl', 'abcdefghij!', '', '../../../etc'])(
    'should answer VIDEO_NOT_FOUND for the malformed id "%s"',
    (value) => {
      expect(() => pipe.transform(value)).toThrow(VideoNotFoundException);
    },
  );

  it('should answer VIDEO_NOT_FOUND for a missing value', () => {
    expect(() => pipe.transform(undefined)).toThrow(VideoNotFoundException);
  });
});
