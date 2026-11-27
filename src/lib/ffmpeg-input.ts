/**
 * Input options for ffmpeg / ffprobe reading a file whose BYTES a caller chose (SSRF-1127).
 *
 * A downloaded "video" can be an HLS playlist, a concat list or an SDP file: ffmpeg detects
 * those by content and then opens every URL they list (http://key-service:8080/..., file:///etc/...),
 * from inside our docker network. Placed right before the `-i` of such a file:
 *  - `-protocol_whitelist file`: the input may open local files only, never http/tcp/udp/rtp;
 *  - `-format_whitelist`: only container demuxers that hold media themselves, never a
 *    playlist/list/description demuxer (hls, concat, sdp, rtsp, image2 patterns, lavfi...).
 * Standalone leaf (no imports), never `vi.mock`'d.
 */

/** Demuxers allowed for a caller-supplied video (ffmpeg demuxer names, each one entry). */
export const SAFE_VIDEO_DEMUXERS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,flv,asf";

/** Per-input options: put them immediately before `-i <untrusted file>`. */
export const SAFE_VIDEO_INPUT_OPTIONS: readonly string[] = [
  "-protocol_whitelist", "file",
  "-format_whitelist", SAFE_VIDEO_DEMUXERS,
];
