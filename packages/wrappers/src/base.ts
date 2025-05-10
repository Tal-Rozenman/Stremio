import {
  Stream,
  ParsedStream,
  StreamRequest,
  ParsedNameData,
  Config,
  ErrorStream,
  ParseResult,
} from '@aiostreams/types';
import { parseFilename } from '@aiostreams/parser';
import {
  getTextHash,
  serviceDetails,
  Settings,
  createLogger,
  maskSensitiveInfo,
} from '@aiostreams/utils';
import { emojiToLanguage, codeToLanguage } from '@aiostreams/formatters';

const logger = createLogger('wrappers');

const IP_HEADERS = [
  'X-Client-IP',
  'X-Forwarded-For',
  'X-Real-IP',
  'True-Client-IP',
  'X-Forwarded',
  'Forwarded-For',
];

export class BaseWrapper {
  private readonly streamPath: string = 'stream/{type}/{id}.json';
  private indexerTimeout: number;
  protected addonName: string;
  private addonUrl: string;
  private addonId: string;
  private userConfig: Config;
  private headers: Headers;
  constructor(
    addonName: string,
    addonUrl: string,
    addonId: string,
    userConfig: Config,
    indexerTimeout?: number,
    requestHeaders?: HeadersInit
  ) {
    this.addonName = addonName;
    this.addonUrl = this.standardizeManifestUrl(addonUrl);
    this.addonId = addonId;
    (this.indexerTimeout = indexerTimeout || Settings.DEFAULT_TIMEOUT),
      (this.userConfig = userConfig);
    this.headers = new Headers({
      'User-Agent': Settings.DEFAULT_USER_AGENT,
      ...(requestHeaders || {}),
    });
    for (const [key, value] of this.headers.entries()) {
      if (!value) {
        this.headers.delete(key);
      }
    }
  }

  protected standardizeManifestUrl(url: string): string {
    // remove trailing slash and replace stremio:// with https://
    let manifestUrl = url.replace('stremio://', 'https://').replace(/\/$/, '');
    return manifestUrl.endsWith('/manifest.json')
      ? manifestUrl
      : `${manifestUrl}/manifest.json`;
  }

  public async getParsedStreams(streamRequest: StreamRequest): Promise<{
    addonStreams: ParsedStream[];
    addonErrors: string[];
  }> {
    const streams: Stream[] = await this.getStreams(streamRequest);
    const errors: string[] = [];
    const finalStreams = streams
      .map((stream) => {
        const { type, result } = this.parseStream(stream);
        if (type === 'error') {
          errors.push(result);
          return undefined;
        } else if (type === 'stream') {
          return result;
        } else {
          return undefined;
        }
      })
      .filter((parsedStream) => parsedStream !== undefined);

    return { addonStreams: finalStreams, addonErrors: errors };
  }

  private getStreamUrl(streamRequest: StreamRequest) {
    return (
      this.addonUrl.replace('manifest.json', '') +
      this.streamPath
        .replace('{type}', streamRequest.type)
        .replace('{id}', encodeURIComponent(streamRequest.id))
    );
  }

  private shouldProxyRequest(url: string): boolean {
    let useProxy: boolean = false;
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch (e: any) {
      logger.error(`Error parsing URL: ${this.getLoggableUrl(url)}`, {
        func: 'shouldProxyRequest',
      });
      return false;
    }
    if (!Settings.ADDON_PROXY) {
      useProxy = false;
    } else if (Settings.ADDON_PROXY_CONFIG || Settings.ADDON_PROXY) {
      useProxy = true;
      if (Settings.ADDON_PROXY_CONFIG) {
        for (const rule of Settings.ADDON_PROXY_CONFIG.split(',')) {
          const [ruleHost, enabled] = rule.split(':');
          if (['true', 'false'].includes(enabled) === false) {
            logger.error(
              `Invalid rule: ${rule}. Rule must be in the format host:enabled`,
              {
                func: 'shouldProxyRequest',
              }
            );
            continue;
          }
          if (ruleHost === '*') {
            useProxy = !(enabled === 'false');
          } else if (ruleHost.startsWith('*')) {
            if (hostname.endsWith(ruleHost.slice(1))) {
              useProxy = !(enabled === 'false');
            }
          }
          if (hostname === ruleHost) {
            useProxy = !(enabled === 'false');
          }
        }
      }
    }
    return useProxy;
  }

  protected getLoggableUrl(url: string): string {
    let urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    const redactedParts = pathParts.length > 3 ? pathParts.slice(1, -3) : [];
    return `${urlObj.protocol}//${urlObj.hostname}/${redactedParts
      .map(maskSensitiveInfo)
      .join(
        '/'
      )}${redactedParts.length ? '/' : ''}${pathParts.slice(-3).join('/')}`;
  }

  protected makeRequest(url: string): Promise<any> {
    const userIp = this.userConfig.requestingIp;
    if (userIp) {
      for (const header of IP_HEADERS) {
        this.headers.set(header, userIp);
      }
    }

    const sanitisedUrl = this.getLoggableUrl(url);
    logger.info(
      `Making a request to ${this.addonName} (${sanitisedUrl}) with user IP ${
        userIp ? maskSensitiveInfo(userIp) : 'not set'
      }`
    );
    logger.debug(
      `Request Headers: ${maskSensitiveInfo(JSON.stringify(Object.fromEntries(this.headers)))}`
    );

    // Always do a direct fetch on Cloudflare Workers
    return fetch(url, {
      method: 'GET',
      headers: this.headers,
      signal: AbortSignal.timeout(this.indexerTimeout),
    });
  }

  protected async getStreams(streamRequest: StreamRequest): Promise<Stream[]> {
    const url = this.getStreamUrl(streamRequest);
    try {
      const response = await this.makeRequest(url);
      if (!response.ok) {
        const text = await response.text();
        let error = `${response.status} - ${response.statusText}`;
        try {
          error += ` with response: ${JSON.stringify(JSON.parse(text))}`;
        } catch {}
        throw new Error(error);
      }

      const results = (await response.json()) as { streams: Stream[] };
      if (!results.streams) {
        throw new Error('Failed to respond with streams');
      }
      return results.streams;
    } catch (error: any) {
      let message = error.message;
      if (error.name === 'TimeoutError') {
        message = `The stream request to ${this.addonName} timed out after ${this.indexerTimeout}ms`;
        return Promise.reject(message);
      }
      logger.error(`Error fetching streams from ${this.addonName}: ${message}`);
      return Promise.reject(error.message);
    }
  }

  protected createParsedResult(data: {
    parsedInfo: ParsedNameData;
    stream: Stream;
    filename?: string;
    folderName?: string;
    size?: number;
    provider?: ParsedStream['provider'];
    seeders?: number;
    usenetAge?: string;
    indexer?: string;
    duration?: number;
    personal?: boolean;
    infoHash?: string;
    message?: string;
  }): ParseResult {
    if (data.folderName === data.filename) {
      data.folderName = undefined;
    }
    return {
      type: 'stream',
      result: {
        ...data.parsedInfo,
        proxied: false,
        message: data.message,
        addon: { name: this.addonName, id: this.addonId },
        filename: data.filename,
        folderName: data.folderName,
        size: data.size,
        url: data.stream.url,
        externalUrl: data.stream.externalUrl,
        _infoHash: data.infoHash,
        torrent: {
          infoHash: data.stream.infoHash,
          fileIdx: data.stream.fileIdx,
          sources: data.stream.sources,
          seeders: data.seeders,
        },
        provider: data.provider,
        usenet: {
          age: data.usenetAge,
        },
        indexers: data.indexer,
        duration: data.duration,
        personal: data.personal,
        type: data.stream.infoHash
          ? 'p2p'
          : data.usenetAge
          ? 'usenet'
          : data.provider
          ? 'debrid'
          : data.stream.url?.endsWith('.m3u8')
          ? 'live'
          : 'unknown',
        stream: {
          subtitles: data.stream.subtitles,
          behaviorHints: {
            countryWhitelist: data.stream.behaviorHints?.countryWhitelist,
            notWebReady: data.stream.behaviorHints?.notWebReady,
            proxyHeaders:
              data.stream.behaviorHints?.proxyHeaders?.request ||
              data.stream.behaviorHints?.proxyHeaders?.response
                ? {
                    request: data.stream.behaviorHints?.proxyHeaders?.request,
                    response: data.stream.behaviorHints?.proxyHeaders?.response,
                  }
                : undefined,
            videoHash: data.stream.behaviorHints?.videoHash,
          },
        },
      },
    };
  }

  // ... the rest of your parsing helpers unchanged ...
}
