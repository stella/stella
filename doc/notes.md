Stella

Filter Google Analytics:
http://support.google.com/googleanalytics/bin/answer.py?hl=en&answer=55481
https://productforums.google.com/forum/#!category-topic/analytics/discuss-google-analytics-features-with-other-users/zhFwwDcKmHo
http://stackoverflow.com/questions/4787694/google-analytics-event-tracking-labels-not-recorded

http://vitalets.github.com/x-editable/

## Spreedly Core

https://devcenter.heroku.com/articles/spreedlycore#support
https://spreedlycore.com/manual/payment-method-interactions

### Initial setup

gw = SpreedlyCore::Gateway.create(:login => 'my_authorize_login', :password => 'my_authorize_password', :gateway_type => 'authorize_net')
gw.use!

gw = Gateway.create(:gateway_type => 'test')
gw.use!

## Good idea: highlighted text == share on twitter

## Running

git pull origin master && \
  bundle exec thin -R config.ru -P /var/run/stella/thin.pid -S /var/run/stella/thin.sock -l /var/log/stella/thin.log -s 3 -d -e production -O restart


## MISC


# FS info
$ sudo debugfs -R features /dev/sda1

sudo mount -o remount,ro /dev/sdb1 /

# Delete has_journal option (http://fenidik.blogspot.ca/2010/03/ext4-disable-journal.html)
tune2fs -O ^has_journal /dev/sda10

## Building rethinkdb (ubuntu-12.10-server-amd64+mac)

$ sudo apt-get install software-properties-common
$ sudo add-apt-repository ppa:rethinkdb/ppa
$ sudo apt-get update
$ sudo apt-get install rethinkdb





## Building rethinkdb (debian-6.0.6-amd64-netinst)

Upgrade kernel:
https://ticketing.nforce.com/index.php?/Knowledgebase/Article/View/27/0/upgrading-the-kernel-to-2638-in-debian-6-squeeze
http://yumechanmiru.blogspot.ca/2012/02/debian-squeeze-32-kernel-update.html

$ Add the following lines to /etc/apt/sources.list
deb http://mirror.peer1.net/debian/ sid main
deb-src http://mirror.peer1.net/debian/ sid main

$ sudo apt-get update

$ sudo apt-get install linux-image-3.2.0-4-amd64 linux-headers-3.2.0-4-amd64

linux-base (3) unstable; urgency=low

  * Some HP Smart Array controllers are now handled by the new 'hpsa'
    driver, rather than the 'cciss' driver.

    While the cciss driver presented disk device names beginning with
    'cciss/', hpsa makes disk arrays appear as ordinary SCSI disks and
    presents device names beginning with 'sd'.  In a system that already
    has other SCSI or SCSI-like devices, names may change unpredictably.

    During the upgrade from earlier versions, you will be prompted to
    update configuration files which refer to device names that may
    change.  You can choose to do this yourself or to follow an automatic
    upgrade process.  All changed configuration files are backed up with
    a suffix of '.old' (or '^old' in one case).

 -- Ben Hutchings <ben@decadent.org.uk>  Wed, 16 Mar 2011 13:19:34 +0000

$ uname -a
Linux bs3-dev-02 2.6.32-5-amd64 #1 SMP Sun Sep 23 10:07:46 UTC 2012 x86_64 GNU/Linux
Linux bs3-dev-02 3.2.0-4-amd64 #1 SMP Debian 3.2.32-1 x86_64 GNU/Linux

$ sudo apt-get install g++ protobuf-compiler protobuf-c-compiler libprotobuf-dev         \
  libprotobuf-c0-dev libboost-dev libssl-dev libv8-dev libboost-program-options-dev \
  libgoogle-perftools-dev libprotoc-dev curl exuberant-ctags m4 \
  zip

$ sudo apt-get install ruby nodejs-legacy
$ sudo npm install -g less coffee-script
$ sudo gem install ruby_protobuf

$ wget https://github.com/rethinkdb/rethinkdb/archive/next.zip
$ unzip next.zip
$ cd rethinkdb-next/src
$ make DEBUG=0


BONUS MATERIAL

$ sudo apt-get install build-essential bison openssl libreadline5 libreadline5-dev curl git-core zlib1g zlib1g-dev libssl-dev libsqlite3-0 libsqlite3-dev sqlite3 libxml2-dev
$ [build node.js - http://nodejs.org/download/]
$ sudo apt-get install libyaml-dev
$ [build ruby - http://www.ruby-lang.org/en/downloads]







## Building rethinkdb (CentOS, incomplete)

Enable EPEL repo: http://www.thegeekstuff.com/2012/06/enable-epel-repository/


$ sudo yum install openssl-devel

$ wget http://nodejs.org/dist/v0.9.3/node-v0.9.3-linux-x64.tar.gz
$ tar zxf node-v0.9.3-linux-x64.tar.gz
$ sudo mv node-v0.9.3-linux-x64 /usr/local
$ sudo ln -s /usr/local/node-v0.9.3-linux-x64 /usr/local/node


$ sudo yum install readline-devel libyaml libffi libffi-devel

$ wget http://ftp.ruby-lang.org/pub/ruby/1.9/ruby-1.9.3-p327.tar.gz
$ tar zxf ruby-1.9.3-p327.tar.gz
$ cd ruby-1.9.3-p327
$ ./configure


$ sudo yum install gcc-c++ boost-devel protobuf* v8 v8-devel ctags google-perftools-devel m4 curl scons

**** $ wget http://jsdoc-toolkit.googlecode.com/files/jsdoc_toolkit-2.4.0.zip

$ git clone --depth 1 -b v1.2.x https://github.com/rethinkdb/rethinkdb.git
  OR
$ wget https://github.com/rethinkdb/rethinkdb/archive/v1.2.4.zip
$ unzip v.1.2.4.zip
$ cd rethinkdb

