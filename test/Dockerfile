FROM ghcr.io/m1k1o/neko/chromium:latest

RUN apt-get update -qq && apt-get install -y -qq python3-pip nodejs npm && pip install --break-system-packages websocket-client && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /usr/share/chromium/extensions/shave

COPY chromium.conf /etc/neko/supervisord/chromium.conf
COPY policies.json /etc/chromium/policies/managed/policies.json
COPY copy-extension.sh /opt/copy-extension.sh
COPY copy.conf /etc/neko/supervisord/copy.conf
RUN chmod +x /opt/copy-extension.sh

CMD ["/usr/bin/supervisord", "-c", "/etc/neko/supervisord.conf"]
