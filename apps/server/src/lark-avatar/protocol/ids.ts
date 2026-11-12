import { createHash, randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const REQUEST_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const generateAccessKey = (input: string): string =>
  createHash('md5').update(input, 'utf8').digest('hex');

const randomFrom = (alphabet: string, length: number): string => {
  const bytes = randomBytes(length);
  let output = '';
  for (let index = 0; index < length; index++) {
    output += alphabet[bytes[index]! % alphabet.length];
  }
  return output;
};

export const generateRequestId = (): string => randomFrom(REQUEST_ALPHABET, 10);
export const generateRequestCid = (): string => randomFrom(ALPHABET, 10);
export const generateLongRequestId = (): string => randomUUID();
