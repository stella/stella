FROM postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280

COPY docker/postgres/prod-parity.conf /etc/postgresql/prod-parity.conf
COPY docker/postgres/init.sql /docker-entrypoint-initdb.d/init.sql
COPY docker/postgres/server.conf /etc/postgresql/server.conf

CMD ["postgres", "-c", "config_file=/etc/postgresql/server.conf"]
