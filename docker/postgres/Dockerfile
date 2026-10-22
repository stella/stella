FROM postgres:18.6@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336

COPY docker/postgres/prod-parity.conf /etc/postgresql/prod-parity.conf
COPY docker/postgres/init.sql /docker-entrypoint-initdb.d/init.sql
COPY docker/postgres/server.conf /etc/postgresql/server.conf

CMD ["postgres", "-c", "config_file=/etc/postgresql/server.conf"]
