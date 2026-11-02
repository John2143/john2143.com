// Single-part multipart/form-data upload parsing (ShareX and curl send one file part).

export interface UploadHeaders {
    key: string;
    filename: string;
    mimetype: string;
    boundary: Buffer;        // "\r\n--<boundary>--\r\n"
    headerSize: number;      // BYTES before the file data
    contentLength?: number;
}

export function parseHeadersFromUpload(data: Buffer, reqHeaders: Record<string, string | undefined>): UploadHeaders | null {
    try {
        const end = data.indexOf("\r\n\r\n");
        if (end < 0) return null;
        const headers = data.subarray(0, end + 4).toString("utf8");
        const b = /boundary="?([^";\s]+)"?/.exec(reqHeaders["content-type"])[1];
        const cl = Number(reqHeaders["content-length"]);
        return {
            key: /name="([A-Za-z0-9]+)"/.exec(headers)[1],
            filename: /filename="([^"]+)"/.exec(headers)[1],
            mimetype: /Content-Type: (.+)\r/.exec(headers)[1],
            boundary: Buffer.from(`\r\n--${b}--\r\n`, "utf8"),
            headerSize: end + 4,
            contentLength: Number.isFinite(cl) && cl > 0 ? cl : undefined,
        };
    } catch {
        return null;
    }
}

export interface BodyTrimmer {
    push(chunk: Buffer): Buffer;
    finish(): Buffer;
}

// Holds back the last boundary.length bytes so a boundary split across chunks is
// never written. finish() drops the tail only if it is exactly the closing boundary.
export function createBodyTrimmer(boundary: Buffer): BodyTrimmer {
    let held: Buffer = Buffer.alloc(0);
    return {
        push(chunk: Buffer): Buffer {
            const buf = held.length ? Buffer.concat([held, chunk]) : chunk;
            const cut = Math.max(0, buf.length - boundary.length);
            held = buf.subarray(cut);
            return buf.subarray(0, cut);
        },
        finish(): Buffer {
            return held.equals(boundary) ? Buffer.alloc(0) : held;
        },
    };
}

export function bodySizeMismatch(h: UploadHeaders, fileSize: number): string | null {
    if (h.contentLength === undefined) return null;
    const expected = h.contentLength - h.headerSize - h.boundary.length;
    return fileSize === expected ? null
        : `Size mismatch: Content-Length ${h.contentLength} implies ${expected} file bytes, received ${fileSize}`;
}
