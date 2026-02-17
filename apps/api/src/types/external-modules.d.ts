declare module 'bullmq' {
  export interface JobsOptions {
    jobId?: string;
    attempts?: number;
    backoff?: number | { type: string; delay: number };
    removeOnComplete?: boolean | number | { count?: number; age?: number };
    removeOnFail?: boolean | number | { count?: number; age?: number };
  }

  export interface Job<DataType = unknown, ResultType = unknown, NameType extends string = string> {
    data: DataType;
    opts: JobsOptions;
    attemptsMade: number;
    returnvalue?: ResultType;
    name: NameType;
  }

  export class Queue<DataType = unknown, ResultType = unknown, NameType extends string = string> {
    constructor(
      name: string,
      options?: {
        connection?: unknown;
        defaultJobOptions?: JobsOptions;
      }
    );
    add(name: NameType, data: DataType, opts?: JobsOptions): Promise<Job<DataType, ResultType, NameType>>;
    close(): Promise<void>;
  }

  export class Worker<DataType = unknown, ResultType = unknown, NameType extends string = string> {
    constructor(
      name: string,
      processor: (job: Job<DataType, ResultType, NameType>) => Promise<ResultType> | ResultType,
      options?: { connection?: unknown; concurrency?: number }
    );
    on(
      event: 'active',
      listener: (job: Job<DataType, ResultType, NameType>) => void | Promise<void>
    ): this;
    on(
      event: 'failed',
      listener: (job: Job<DataType, ResultType, NameType> | undefined, error: Error) => void | Promise<void>
    ): this;
    on(event: 'error', listener: (error: Error) => void | Promise<void>): this;
    close(): Promise<void>;
  }
}

declare module 'ioredis' {
  class Redis {
    constructor(url?: string, options?: Record<string, unknown>);
    incr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    quit(): Promise<string>;
  }
  export default Redis;
}

declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
  }

  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}
