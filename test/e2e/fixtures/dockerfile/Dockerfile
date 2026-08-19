# DOCKERFILE 프리셋 검증용 픽스처.
FROM alpine:3.20
CMD ["sh", "-c", "while true; do printf 'HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\noptics-df-ok' | nc -l -p 3000; done"]
