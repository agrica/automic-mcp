/** Splits a byte stream into complete lines; a trailing fragment waits for the next chunk. */
export class LineReader {
  #rest = '';

  /** Returns the non-empty lines completed by this chunk. */
  push(chunk: string): string[] {
    const parts = (this.#rest + chunk).split('\n');
    this.#rest = parts.pop() ?? '';
    return parts.map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
  }

  /** Text received after the last newline (an incomplete message). */
  get rest(): string {
    return this.#rest;
  }
}
