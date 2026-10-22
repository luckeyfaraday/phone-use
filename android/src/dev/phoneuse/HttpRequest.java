package dev.phoneuse;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Bounded HTTP/1.1 reader. Content-Length counts bytes, including for non-ASCII text. */
final class HttpRequest {
    final String method, target, body;
    final Map<String, String> headers;

    private HttpRequest(String method, String target, String body, Map<String, String> headers) {
        this.method = method;
        this.target = target;
        this.body = body;
        this.headers = headers;
    }

    static HttpRequest read(InputStream input) throws IOException {
        String line = line(input);
        if (line == null) return null;
        String[] request = line.split(" ");
        if (request.length != 3 || !request[2].startsWith("HTTP/1.")) throw new IOException("invalid request line");
        Map<String, String> headers = new HashMap<>();
        int total = line.length();
        while ((line = line(input)) != null && !line.isEmpty()) {
            total += line.length();
            if (total > 16384) throw new IOException("headers too large");
            int colon = line.indexOf(':');
            if (colon < 1) throw new IOException("invalid header");
            String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
            if (headers.put(name, line.substring(colon + 1).trim()) != null) throw new IOException("duplicate header");
        }
        if (line == null) throw new EOFException("incomplete headers");
        if (headers.containsKey("transfer-encoding")) throw new IOException("use Content-Length, not Transfer-Encoding");
        int length;
        try { length = Integer.parseInt(headers.getOrDefault("content-length", "0")); }
        catch (NumberFormatException e) { throw new IOException("invalid Content-Length"); }
        if (length < 0 || length > 1024 * 1024) throw new IOException("body too large");
        byte[] body = new byte[length];
        for (int offset = 0; offset < length; ) {
            int count = input.read(body, offset, length - offset);
            if (count < 0) throw new EOFException("incomplete body");
            offset += count;
        }
        return new HttpRequest(request[0], request[1], new String(body, StandardCharsets.UTF_8), headers);
    }

    private static String line(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int b; (b = input.read()) != -1; ) {
            if (b == '\n') {
                String value = new String(bytes.toByteArray(), StandardCharsets.US_ASCII);
                return value.endsWith("\r") ? value.substring(0, value.length() - 1) : value;
            }
            bytes.write(b);
            if (bytes.size() > 8192) throw new IOException("line too long");
        }
        if (bytes.size() != 0) throw new EOFException("incomplete line");
        return null;
    }
}
