FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY pyproject.toml README.md ./
COPY src/ src/
RUN pip install --no-cache-dir -e .
# baked default config so `docker run -p 8080:8080 proxyhub` just works;
# mount your own at /app/config.yaml or override scalars via PROXYHUB_* env
COPY config.default.yaml /app/config.yaml
VOLUME /var/cache/proxyhub
EXPOSE 8080
ENTRYPOINT ["proxyhub", "-c", "/app/config.yaml"]
