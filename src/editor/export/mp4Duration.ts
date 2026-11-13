/** 一个封装器生成的 MP4 box。媒体数据位于独立 mdat，不经此处解析。 */
interface Mp4Box {
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** 已有 edit list 的段，保留媒体起点和播放速率。 */
interface Edit {
  length: bigint;
  start: bigint;
  rate: number;
}

const boxText = new TextDecoder();
const boxEncoder = new TextEncoder();

/** 为 mp4 的可播放区间设置硬上限，AAC 填充和视频末帧取整留在媒体数据内。 */
export function capMp4MovieDuration(moov: Uint8Array, durationSec: number): Uint8Array<ArrayBuffer> {
  const children = readBoxes(moov);
  const movie = requireBox(children, "mvhd").bytes;
  const timescale = dataView(movie).getUint32(movie[8] === 1 ? 28 : 20);
  const maximum = BigInt(Math.floor(durationSec * timescale + 1e-7));
  let duration = 0n;
  for (const box of children) {
    if (box.type !== "trak") continue;
    const track = capTrack(box.bytes, maximum);
    box.bytes = track.bytes;
    if (track.duration > duration) duration = track.duration;
  }
  writeDuration(movie, movie[8] === 1 ? 32 : 24, duration);
  return makeBox(
    "moov",
    children.map((box) => box.bytes),
  );
}

/** 保留已有的起始偏移和 AAC priming，仅裁剪 edit list 超过结尾的部分。 */
function capTrack(bytes: Uint8Array, maximum: bigint): { bytes: Uint8Array<ArrayBuffer>; duration: bigint } {
  const children = readBoxes(bytes);
  const header = requireBox(children, "tkhd").bytes;
  const offset = header[8] === 1 ? 36 : 28;
  const oldDuration = readDuration(header, offset);
  const edts = children.find((box) => box.type === "edts");
  const editBoxes = edts ? readBoxes(edts.bytes) : [];
  const existing = editBoxes.find((box) => box.type === "elst");
  const edits = existing ? readEdits(existing.bytes) : [{ length: oldDuration, start: 0n, rate: 0x10000 }];
  let remaining = maximum;
  const retained: Edit[] = [];
  for (const edit of edits) {
    if (remaining === 0n) break;
    const length = edit.length < remaining ? edit.length : remaining;
    if (length > 0n) retained.push({ ...edit, length });
    remaining -= length;
  }
  const duration = maximum - remaining;
  writeDuration(header, offset, duration);
  const replacement = makeBox("edts", [...editBoxes.filter((box) => box.type !== "elst").map((box) => box.bytes), makeEdits(retained)]);
  if (edts) edts.bytes = replacement;
  else children.push({ type: "edts", bytes: replacement });
  return {
    bytes: makeBox(
      "trak",
      children.map((box) => box.bytes),
    ),
    duration,
  };
}

/** 解析 Mediabunny 写出的普通 32 位大小子 box。 */
function readBoxes(bytes: Uint8Array): Mp4Box[] {
  const view = dataView(bytes);
  const result: Mp4Box[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error("MP4 时长元数据不完整");
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > bytes.length) throw new Error("MP4 时长元数据无效");
    result.push({
      type: boxText.decode(bytes.subarray(offset + 4, offset + 8)),
      bytes: new Uint8Array(bytes.subarray(offset, offset + size)),
    });
    offset += size;
  }
  return result;
}

/** 重新组装小体积的时长元数据，不移动 mdat 中的样本偏移。 */
function makeBox(type: string, payload: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(payload.reduce((size, part) => size + part.length, 8));
  dataView(bytes).setUint32(0, bytes.length);
  bytes.set(boxEncoder.encode(type), 4);
  let offset = 8;
  for (const part of payload) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** 保留 v0/v1 edit list 的有符号媒体起点，包括空段的 -1。 */
function readEdits(bytes: Uint8Array): Edit[] {
  const view = dataView(bytes);
  const large = bytes[8] === 1;
  const size = large ? 20 : 12;
  const count = view.getUint32(12);
  if (16 + count * size > bytes.length) throw new Error("MP4 edit list 长度无效");
  return Array.from({ length: count }, (_, index) => {
    const offset = 16 + index * size;
    return {
      length: large ? view.getBigUint64(offset) : BigInt(view.getUint32(offset)),
      start: large ? view.getBigInt64(offset + 8) : BigInt(view.getInt32(offset + 4)),
      rate: view.getInt32(offset + size - 4),
    };
  });
}

/** 输出 v1 避免在长视频中截断 edit list 的时长。 */
function makeEdits(edits: Edit[]): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(8 + edits.length * 20);
  const view = dataView(payload);
  payload[0] = 1;
  view.setUint32(4, edits.length);
  for (const [index, edit] of edits.entries()) {
    const offset = 8 + index * 20;
    view.setBigUint64(offset, edit.length);
    view.setBigInt64(offset + 8, edit.start);
    view.setInt32(offset + 16, edit.rate);
  }
  return makeBox("elst", [payload]);
}

/** 从 FullBox 读取对应版本的时长字段。 */
function readDuration(bytes: Uint8Array, offset: number): bigint {
  const view = dataView(bytes);
  return bytes[8] === 1 ? view.getBigUint64(offset) : BigInt(view.getUint32(offset));
}

/** 把裁剪结果写回对应版本的时长字段。 */
function writeDuration(bytes: Uint8Array, offset: number, value: bigint): void {
  const view = dataView(bytes);
  if (bytes[8] === 1) view.setBigUint64(offset, value);
  else view.setUint32(offset, Number(value));
}

/** 只查看当前 box 的字节范围。 */
function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 缺少必需时长字段则报封装错误。 */
function requireBox(boxes: Mp4Box[], type: string): Mp4Box {
  const box = boxes.find((item) => item.type === type);
  if (!box) throw new Error(`MP4 缺少时长元数据 ${type}`);
  return box;
}
