package dev.phoneuse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public class HttpRequestTest {
    private static HttpRequest parse(String wire) throws Exception {
        return HttpRequest.read(new ByteArrayInputStream(wire.getBytes(StandardCharsets.UTF_8)));
    }
    private static void rejects(String wire) throws Exception {
        try { parse(wire); throw new AssertionError("accepted invalid HTTP"); }
        catch (IOException expected) { }
    }
    public static void main(String[] args) throws Exception {
        String body = "{\"text\":\"café 日本語 👋\"}";
        HttpRequest request = parse("POST /type HTTP/1.1\r\nContent-Length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\nX-Phone-Use-Token: example\r\n\r\n" + body);
        if (!request.body.equals(body)) throw new AssertionError("Unicode corrupted");
        if (!request.headers.get("x-phone-use-token").equals("example")) throw new AssertionError("header normalization");
        if (!parse("GET /status HTTP/1.1\r\n\r\n").body.isEmpty()) throw new AssertionError("GET body");
        rejects("POST /type HTTP/1.1\r\nContent-Length: -1\r\n\r\n");
        rejects("POST /type HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n");
        rejects("POST /type HTTP/1.1\r\nContent-Length: 3\r\n\r\nx");
        rejects("POST /type HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n");
        rejects("GET /status HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n");
        rejects("GET /status HTTP/1.1\r\nX-Test: " + "x".repeat(9000) + "\r\n\r\n");
        rejects("GET /status HTTP/1.1\r\n");
        System.out.println("HTTP parser: 10 checks passed");
    }
}
