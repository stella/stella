FROM postgres:18.6@sha256:bc8d7bdd54dc38115ef954fef07f30a96bb2b5b080effa692e0093f03eabac8f

COPY docker/postgres/prod-parity.conf /etc/postgresql/prod-parity.conf
COPY docker/postgres/init.sql /docker-entrypoint-initdb.d/init.sql
COPY docker/postgres/server.conf /etc/postgresql/server.conf

CMD ["postgres", "-c", "config_file=/etc/postgresql/server.conf"]
