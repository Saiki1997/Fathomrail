/** Minimal ZIP (store + deflate via CompressionStream when available). */

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  const copy = data.slice();
  const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function zipFiles(files: Array<{ name: string; data: Uint8Array }>): Promise<Blob> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name.replace(/\\/g, "/"));
    const crc = crc32(file.data);
    const deflated = await deflate(file.data);
    const useDeflate = deflated && deflated.length < file.data.length;
    const payload = useDeflate ? deflated! : file.data;
    const method = useDeflate ? 8 : 0;

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    local.set([0x50, 0x4b, 0x03, 0x04], 0);
    local.set(u16(20), 4);
    local.set(u16(0), 6);
    local.set(u16(method), 8);
    local.set(u16(0), 10);
    local.set(u16(0), 12);
    local.set(u32(crc), 14);
    local.set(u32(payload.length), 18);
    local.set(u32(file.data.length), 22);
    local.set(u16(nameBytes.length), 26);
    local.set(u16(0), 28);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    central.set([0x50, 0x4b, 0x01, 0x02], 0);
    central.set(u16(20), 4);
    central.set(u16(20), 6);
    central.set(u16(0), 8);
    central.set(u16(method), 10);
    central.set(u16(0), 12);
    central.set(u16(0), 14);
    central.set(u32(crc), 16);
    central.set(u32(payload.length), 20);
    central.set(u32(file.data.length), 24);
    central.set(u16(nameBytes.length), 28);
    central.set(u16(0), 30);
    central.set(u16(0), 32);
    central.set(u16(0), 34);
    central.set(u16(0), 36);
    central.set(u32(0), 38);
    central.set(u32(offset), 42);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = new Uint8Array(22);
  end.set([0x50, 0x4b, 0x05, 0x06], 0);
  end.set(u16(0), 4);
  end.set(u16(0), 6);
  end.set(u16(files.length), 8);
  end.set(u16(files.length), 10);
  end.set(u32(centralSize), 12);
  end.set(u32(offset), 16);
  end.set(u16(0), 20);

  return new Blob([...locals.map((u) => u.slice()), ...centrals.map((u) => u.slice()), end.slice()], {
    type: "application/zip",
  });
}

export function triggerDownload(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
