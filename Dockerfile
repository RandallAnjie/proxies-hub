FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY pyproject.toml README.md ./
COPY src/ src/
RUN pip install --no-cache-dir -e .
VOLUME /var/cache/proxyhub
EXPOSE 8080
ENTRYPOINT ["proxyhub", "-c", "/app/config.yaml"]
