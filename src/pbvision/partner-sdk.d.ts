// Ambient declaration for @pbvision/partner-sdk. The published package is
// JSDoc-annotated JS without a .d.ts; this lets TS import the named export
// without falling back to implicit-any. Only declares the methods we use.

declare module "@pbvision/partner-sdk" {
  export interface VideoMetadata {
    userEmails?: string[];
    name?: string;
    desc?: string;
    gameStartEpoch?: number;
    facility?: string;
    court?: string;
    fid?: number;
  }

  export interface VideoUrlToDownloadResponse {
    vid?: string;
    hasCredits?: boolean;
  }

  export class PBVision {
    constructor(apiKey: string, opts?: { useProdServer?: boolean });

    setWebhook(webhookUrl: string): Promise<unknown>;
    getVideoEditors(vid: string): Promise<unknown>;
    setVideoEditors(
      vid: string,
      editorEmails: string[],
      viewerEmails: string[],
    ): Promise<unknown>;
    sendVideoUrlToDownload(
      videoUrl: string,
      metadata?: VideoMetadata,
    ): Promise<VideoUrlToDownloadResponse>;
    uploadVideo(
      mp4Filename: string,
      metadata?: VideoMetadata,
    ): Promise<VideoUrlToDownloadResponse>;
  }
}
