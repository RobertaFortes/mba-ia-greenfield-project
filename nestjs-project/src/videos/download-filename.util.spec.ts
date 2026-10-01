import { toSafeDownloadFilename } from './download-filename.util';

describe('toSafeDownloadFilename', () => {
  it('should keep an ordinary filename', () => {
    expect(toSafeDownloadFilename('my holiday.mp4')).toBe('my holiday.mp4');
  });

  it('should strip double quotes', () => {
    expect(toSafeDownloadFilename('a"b".mp4')).toBe('ab.mp4');
  });

  it('should strip path separators of both kinds', () => {
    expect(toSafeDownloadFilename('../../etc/pass\\wd.mp4')).toBe(
      '....etcpasswd.mp4',
    );
  });

  it('should strip control characters including CR and LF', () => {
    expect(toSafeDownloadFilename('a\r\nb\u0000c.mp4')).toBe('abc.mp4');
  });

  it.each(['', '   ', '"""', '///', '\r\n'])(
    'should fall back to "video" when nothing is left of %j',
    (input) => {
      expect(toSafeDownloadFilename(input)).toBe('video');
    },
  );
});
