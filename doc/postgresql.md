# Basic setup for postgresql database
#
# Install Postgresql 9.1 from the Postgres Yum repo
[root@vmdev ~]# rpm -Uvh http://yum.pgrpms.org/reporpms/9.1/pgdg-centos91-9.1-4.noarch.rpm

# Create a profile.d file called 'posgresql91.sh' which modifies the user PATH

    [root@vmdev profile.d]# cat /etc/profile.d/postgresql91.sh
    #!/bin/bash
    PATH=/usr/pgsql-9.1/bin/:$PATH


# Initialize Postgres database

    [root@vmdev ~]# /etc/init.d/postgresql-9.1 initdb
    Initializing database:                                     [  OK  ]
    [root@vmdev ~]# /etc/init.d/postgresql-9.1 start
    Starting postgresql-9.1 service:                           [  OK  ]

# OSX (dev):  pg_ctl -D /data/postgres start

# su to postgres user, create stella user
[root@vmdev ~]# su - postgres
-bash-4.1$ createuser stella
Shall the new role be a superuser? (y/n) n
Shall the new role be allowed to create databases? (y/n) n
Shall the new role be allowed to create more new roles? (y/n) n

# create stella database
-bash-4.1$ createdb -E unicode -O stella stella

# set a password for the stella user
-bash-4.1$ psql
psql (9.1.1)
Type "help" for help.

postgres=# alter user stella with password 'thepassword';

# as root, edit the postgresql.conf file to bind to all IPs
[root@vmdev ~]# vim /var/lib/pgsql/9.1/data/postgresql.conf

# uncomment the listen_address line, change 'localhost for '*'
listen_addresses = '*'

# as root, edit the pg_hba.conf file
[root@vmdev ~]# vim /var/lib/pgsql/9.1/data/pg_hba.conf

# change both IP host entries from 'ident' to 'md5' (see below), add an entry
# for all hosts
# IPv4 local connections:
host    all             all             127.0.0.1/32            md5
# IPv6 local connections:
host    all             all             ::1/128                 md5
# All IPv4 hosts
host    all             all             0.0.0.0/0               md5


# restart the postgres database (as root)

[root@vmdev ~]# service postgresql-9.1 restart
Stopping postgresql-9.1 service:                           [  OK  ]
Starting postgresql-9.1 service:                           [  OK  ]
[root@vmdev ~]# su - postgres

# verify that local socket connections as stella require a password (and fail)
# DANGEROUS WAY:
-bash-4.1$ psql -U stella stella
psql: FATAL:  Peer authentication failed for user "stella"

# SAFER WAY:
-bash-4.1$ psql -U stella -h localhost stella
Password for user stella:
psql (9.1.1)
Type "help" for help.

stella=>\q

# RUBY GEM
bundle config build.do_postgres --with-pgsql-server-include=/usr/pgsql-9.1/include/server/ --with-pgsql-client-dir=/usr/pgsql-9.1/
bundle config build.pg --with-pg-lib=/usr/pgsql-9.1/lib/ --with-pg-config=/usr/pgsql-9.1/bin/pg_config

http://stackoverflow.com/questions/4707401/pg-config-ruby-pg-postgresql-9-0-problem-after-upgrade-centos-5

