FROM postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42

COPY docker/postgres/prod-parity.conf /etc/postgresql/prod-parity.conf
COPY docker/postgres/init.sql /docker-entrypoint-initdb.d/init.sql
COPY docker/postgres/server.conf /etc/postgresql/server.conf

CMD ["postgres", "-c", "config_file=/etc/postgresql/server.conf"]
