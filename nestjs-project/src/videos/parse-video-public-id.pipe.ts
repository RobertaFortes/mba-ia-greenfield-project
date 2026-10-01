import { Injectable, PipeTransform } from '@nestjs/common';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { isValidPublicId } from './public-id.util';

/** A malformed id answers 404, exactly like an unknown one (no id probing). */
@Injectable()
export class ParseVideoPublicIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (!isValidPublicId(value)) throw new VideoNotFoundException();
    return value;
  }
}
