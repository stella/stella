require 'bundler/setup'

require 'sysinfo'
require 'public_suffix'

autoload :Addressable, 'addressable/uri'
autoload :Resolv, 'resolv'
autoload :IPAddr, 'ipaddr'
autoload :Redis, 'redis/objects'
autoload :Yajl, 'yajl'
autoload :DataMapper, 'data_mapper'
autoload :Magick, 'RMagick'
autoload :SecureRandom, 'securerandom'
autoload :SendGrid, 'sendgrid'
autoload :Twilio, 'twilio'
autoload :Base64, 'base64'
autoload :Zlib, 'zlib'
autoload :Timeout, "timeout"

require 'gibbler/mixins'
Gibbler.secret = 'PLEASECHANGEMESTELLA'

require 'stella/core_ext'
require 'stella/errors'
require 'stella/logic'
require 'stella/model'

class Stella
  autoload :API, 'stella/api/client'
  autoload :RedisObject, 'stella/redisobject'
  autoload :Entropy, 'stella/redisobject'
  autoload :Session, 'stella/redisobject/session'
  autoload :Vendors, 'stella/vendors'
  autoload :Job, 'stella/job'
  autoload :SmartQueue, 'stella/queue'
  autoload :Queueable, 'stella/queue'
  autoload :Notifier, 'stella/notification'
  autoload :Email, 'stella/email'

  unless defined?(Stella::HOME)
    HOME = File.expand_path( File.join(File.dirname(__FILE__), '..') )
  end
  module VERSION
    def self.to_a
      load_config
      [@version[:MAJOR], @version[:MINOR], @version[:PATCH], @version[:BUILD]]
    end
    def self.to_s
      to_a.join('.')
    end
    def self.inspect
      to_a.join('.')
    end
    def self.increment!(msg=nil)
      load_config if @version.nil?
      @version[:BUILD] = @version[:BUILD].to_s.succ!
      @version[:STAMP] = Stella.now.to_i
      @version[:OWNER] = Stella.sysinfo.user
      @version[:STORY] = msg || '[no message]'
      @version.to_yaml.to_file path, 'w'
      @version
    end
    def self.path
      File.join(Stella::HOME, 'BUILD.yml')
    end
    def self.load_config
      return if @version
      require 'yaml'
      @version = YAML.load_file(path)
    end
    class << self
      attr_reader :version
    end
  end
end

class Stella
  @mode   = nil
  @debug  = nil
  @noise  = 0
  @quiet = true
  @redis_scripts = {}
  #@agent  = "Mozilla/5.0 (compatible; Stella/#{Stella::VERSION}; +https://www.blamestella.com/)"
  class << self
    attr_reader :instance, :config, :agent, :redis_connection, :redis_scripts
    attr_accessor :mode, :noise, :quiet
    attr_writer :env, :debug
    def quiet?
      quiet == true
    end
    def now n=Time.now
      n.utc
    end
    def mode? guess
      @mode.to_s == guess.to_s
    end
    def debug?
      @debug == true
    end
    def colonel? guess
      (Stella.config['site.colonels'] || []).member?(guess.to_s)
    end
    def debug
      @debug || (@debug.nil? && !ENV['STELLA_DEBUG'].to_s.empty?)
    end
    def rescue(&blk)
      blk.call
    rescue Stella::Problem => ex
      Stella.lc ex.message
      STDERR.puts ex.backtrace
    end
    def sysinfo
      @sysinfo ||= SysInfo.new.freeze
      @sysinfo
    end
    def redis(db=0)
      @redis_connection ||= []
      @redis_connection[db] ||= Redis.new(:host => 'localhost', :port => 6379, :db => db)
      @redis_connection[db]
    end
    def generate_instanceid
      Gibbler.new Stella.sysinfo.hostname, Stella.sysinfo.user, $$, Stella::VERSION.to_s, Stella.now.to_f
    end
    def env
      @env || ENV['RACK_ENV'] || 'prod'
    end
    def env? guess
      guess.to_s.downcase == env.downcase
    end
    def load! mode=:cli, reload=false
      return unless @instance.nil? || reload
      @mode = mode
      @instance = generate_instanceid
      @config = Stella::Config.load || @config || {}
      @env ||= ENV['RACK_ENV'] ||= Stella.config['site.env']
      Stella.ld "---  STELLA v#{Stella::VERSION}  -----------------------------------"
      Stella.ld "[%d/%s] %s/%s %s-%s @ %s" % [$$, Stella.instance.short,
        Stella.mode, Stella.env, Stella.sysinfo.vm, Stella.sysinfo.ruby.join('.'), Time.now.utc]
      if Stella.config['db.uri'].to_s.empty?
        Stella.li "No database specified. (Check db.uri)"
      else
        load_db
        DataMapper.finalize
      end
      Gibbler.secret = Stella.config['site.secret'] if Stella.config['site.secret']
      Stella.li "You need to update site.secret" if Gibbler.secret == "PLEASECHANGEMESTELLA"
      Stella.config['site.ssl_ca_file'] ||= File.join(Stella::HOME, 'certs', 'stella-master.crt')
      if Stella.config['redis.uri']
        Stella::Session.redis = Stella.redis(1)
        Stella::Job.redis = Stella.redis(11)
        Stella::Secret.redis = Stella.redis(2)
        @redis_scripts = Stella::RedisObject.load_scripts
      end
      SendGrid.api_user = Stella.config['vendor.sendgrid.user']
      SendGrid.api_key = Stella.config['vendor.sendgrid.key']
      SendGrid.hostname = Stella.sysinfo.hostname
      Twilio.connect(Stella.config['vendor.twilio.sid'], Stella.config['vendor.twilio.token'])
      # If we don't specify a cert authority file, the Twilio lib can raise
      # "certificate verify failed" errors on some machines.
      Twilio.ssl_ca_file Stella.config['site.ssl_ca_file']
      SendGrid.ssl_ca_file Stella.config['site.ssl_ca_file']
      if Stella.debug
        SendGrid.debug_output $stderr
        Twilio.debug_output $stderr
      end
      Stella::Product.load!
      true
    rescue Stella::NoRedis => ex
      Stella.lc ex.message rescue nil
      false
    end
    def reload!
      load! mode, true
    end
    def load_db
      @config ||= Stella::Config.load
      ENV['TZ'] = 'UTC'  # Important for datamapper
      DataMapper::Logger.new($stderr, :debug) if Stella.debug
      DataMapper.setup(:default, Stella.config['db.uri'])
    end
  end
end


require 'syslog'
class Stella
  #
  # Stella::Logger
  #
  # Used throughout Stella for info, debug, and critical
  # logging to syslog.
  #
  # +name+: Program name to log as.
  #
  # Usage:
  #
  #     class SomeClass
  #       extend Stella::Logger
  #     end
  #
  #     SomeClass.li "some info"
  #     SomeClass.ld "only a debugging message"
  #     SomeClass.lc "some critical message"
  #
  module Logger
    SYSLOG = Syslog.open('stella') unless defined?(Stella::Logger::SYSLOG)
    [[:info, :li], [:debug, :ld], [:crit, :lc]].each do |args|
      severity, meth = *args
      define_method meth do |msg|
        return if severity == :debug && !Stella.debug
        STDERR.puts(msg) if Stella.debug || STDOUT.tty? #&& severity == :debug
        SYSLOG.send severity, clean(msg)
      end
    end
    def self.close
      SYSLOG.close if SYSLOG.opened?
    end
    def self.open name='stella'
      SYSLOG.opened? ? SYSLOG : const_set(:SYSLOG, Syslog.open(name))
    end
    def self.reopen name='stella'
      self.close
      self.open(name)
    end
    private
    def clean msg
      msg = msg.to_s.strip
      msg.gsub!(/%/, '%%') # syslog(3) freaks on % (printf)
      msg.gsub!(/\e\[[^m]*m/, '') # remove useless ansi color codes
      msg
    end
  end
  extend Stella::Logger

  #
  # Stella::Config
  #
  # Used throughout Stella as the interface to configuration
  # stored in redis. Looks in the following locations:
  #
  #   ~/.stella/config
  #   /etc/stella/config
  #
  module Config
    extend self
    SERVICE_PATHS = %w[/etc/stella ./etc].freeze
    UTILITY_PATHS = %w[~/.stella /etc/stella ./etc].freeze
    attr_reader :base, :bootstrap, :path
    def load path=self.find_path
      return if @noconfig
      conf = if self.exists?
        Stella.ld "Loading #{path}"
        raise ArgumentError, "Bad path (#{path})" unless File.readable?(path)
        YAML.load_file path
      else
        @noconfig = true
        Stella.ld "No config found"
        {}
      end
      conf['stella.remote'] ||= ENV['STELLA_REMOTE']
      conf['stella.custid'] ||= ENV['STELLA_CUSTID']
      conf['stella.apikey'] ||= ENV['STELLA_APIKEY']
      conf
    rescue Psych::SyntaxError => ex
      Stella.li "#{ex.message} (#{ex.class})"
      exit 1
    end
    def exists?
      !find_path.nil?
    end
    def find_path
      @path ||= find_configs.first
    end
    def find_configs
      paths = Stella.mode?(:cli) ? UTILITY_PATHS : SERVICE_PATHS
      paths = paths.collect { |f|
        f = File.join File.expand_path(f), 'config'
        #Stella.ld "Looking for #{f}"
        f if File.exists?(f) && !File.new(f).size.zero?
      }.compact
      if paths.empty?
        paths.unshift File.join(Stella::HOME, 'etc', 'config')
      end
      paths
    end
  end

  IMAGE_EXT = %w/.bmp .gif .jpg .jpeg .png .ico/ unless defined?(Stella::IMAGE_EXT)
  module Utils
    extend self
    include Socket::Constants

    ADDR_LOCAL = IPAddr.new("127.0.0.0/8")
    ADDR_CLASSA = IPAddr.new("10.0.0.0/8")
    ADDR_CLASSB = IPAddr.new("172.16.0.0/16")
    ADDR_CLASSC = IPAddr.new("192.168.0.0/24")

    # See: https://forums.aws.amazon.com/ann.jspa?annID=877
    ADDR_EC2_US_EAST = %w{
      216.182.224.0/20
      72.44.32.0/19
      67.202.0.0/18
      75.101.128.0/17
      174.129.0.0/16
      204.236.192.0/18
      184.73.0.0/16
      184.72.128.0/17
      184.72.64.0/18
      50.16.0.0/15
    }.collect { |ipr| IPAddr.new(ipr.strip) }

    ADDR_EC2_US_WEST = %w{
      204.236.128.0/18
      184.72.0.0/18
      50.18.0.0/18
    }.collect { |ipr| IPAddr.new(ipr.strip) }

    ADDR_EC2_EU_WEST = %w{
      79.125.0.0/17
      46.51.128.0/18
      46.51.192.0/20
      46.137.0.0/17
    }.collect { |ipr| IPAddr.new(ipr.strip) }

    ADDR_EC2_AP_EAST = %w{
      175.41.128.0/18
      122.248.192.0/18
    }.collect { |ipr| IPAddr.new(ipr.strip) }

    def image_ext?(name)
      IMAGE_EXT.include?(File.extname(name.downcase))
    end

    def image?(s)
      return false if s.nil?
      (bmp?(s) || jpg?(s) || png?(s) || gif?(s) || ico?(s))
    end

    # Checks if the file has more than 30% non-ASCII characters.
    # NOTE: how to determine the difference between non-latin and binary?
    def binary?(s)
      return false if s.nil?
      #puts "TODO: fix encoding issue in 1.9"
      s = s.to_s.split(//) rescue [] unless Array === s
      s.slice!(0, 4096)  # limit to a typcial blksize
      ((s.size - s.grep(" ".."~").size) / s.size.to_f) > 0.30
    end

    # Based on ptools by Daniel J. Berger
    # http://raa.ruby-lang.org/project/ptools/
    def bmp?(a)
      possible = ['BM6', 'BM' << 226.chr]
      possible.member? a.slice(0, 3)
    end

    # Based on ptools by Daniel J. Berger
    # http://raa.ruby-lang.org/project/ptools/
    def jpg?(a)
      a.slice(0, 10) == "\377\330\377\340\000\020JFIF"
    end

    # Based on ptools by Daniel J. Berger
    # http://raa.ruby-lang.org/project/ptools/
    def png?(a)
      a.slice(0, 4) == "\211PNG"
    end

    def ico?(a)
      a.slice(0, 3) == [0.chr, 0.chr, 1.chr].join
    end

    # Based on ptools by Daniel J. Berger
    # http://raa.ruby-lang.org/project/ptools/
    def gif?(a)
      ['GIF89a', 'GIF97a'].include?(a.slice(0, 6))
    end

    #
    # Generates a string of random alphanumeric characters.
    # * +len+ is the length, an Integer. Default: 8
    # * +safe+ in safe-mode, ambiguous characters are removed (default: true):
    #       i l o 1 0
    def strand( len=8, safe=true )
       chars = ("a".."z").to_a + ("0".."9").to_a
       chars.delete_if { |v| %w(i l o 1 0).member?(v) } if safe
       str = ""
       1.upto(len) { |i| str << chars[rand(chars.size-1)] }
       str
    end

    def sid *input
      Gibbler.new *input
    end

    # File.read(file_path)
    def base64_encode(str)
      Base64.encode64(str).gsub(/\s+/, "")
    end

    def base64_decode(str)
      Base64.decode64(str)
    end

    def resize file, width, height, suffix
      ext = File.extname(file)
      path, format, basename = File.dirname(file), ext.tr('.', ''), File.basename(file, ext)
      name, size = basename.split('-')
      outfile = File.join(path, '%s-%s.%s' % [name, suffix, format])
      img = Magick::Image.read(file).first
      img.resize_to_fill(width.to_i,height.to_i,Magick::NorthGravity).write(outfile)
      outfile
    end

    # http://www.blamestella.com/ => www.blamestella.com
    def host(host)
      return nil if host.nil?
      if host.kind_of?(URI)
        uri = host
      else
        host &&= host.to_s
        host.strip!
        host = host.to_s unless String === host
        host = "http://#{host}" unless host.match(/^https?:\/\//)
        uri = Addressable::URI.parse(host)
      end
      str = "#{uri.host}".downcase
      #str << ":#{uri.port}" if uri.port && uri.port != 80
      str
    end
    # www.blamestella.com => http://www.blamestella.com/
    def uri(uri)
      return nil if uri.nil?
      if uri.kind_of?(URI)
        uri = Addressable::URI.parse uri.to_s
      else
        uri &&= uri.to_s
        uri.strip! unless uri.frozen?
        uri = Addressable::URI.parse(uri)
      end
      uri.scheme ||= 'http'
      uri.path = '/' if uri.path.to_s.empty?
      uri
    end
    # www.blamestella.com => blamestella.com
    def domain(host)
      begin
        PublicSuffix.parse host
      rescue PublicSuffix::DomainInvalid => ex
        Stella.ld ex.message
        nil
      rescue => ex
        Stella.li "Error determining domain for #{host}: #{ex.message} (#{ex.class})"
        Stella.ld ex.backtrace
        nil
      end
    end
    # Returns an Array of ip addresses or nil
    def ipaddr(host)
      host = host.host if host.kind_of?(URI)
      begin
        resolv = Resolv::DNS.new # { :nameserver => [] }
        resolv.getaddresses(host).collect { |addr| addr.to_s }
      rescue => ex
        Stella.ld "Error getting ip address for #{host}: #{ex.message} (#{ex.class})"
        Stella.ld ex.backtrace
        nil
      end
    end

    # Returns a cname or nil
    def cname(host)
      require 'resolv'
      host = host.host if host.kind_of?(URI)
      begin
        resolv = Resolv::DNS.new # { :nameserver => [] }
        resolv.getresources(host, Resolv::DNS::Resource::IN::CNAME).collect { |cname| cname.name.to_s }.first
      rescue => ex
        Stella.ld "Error getting CNAME for #{host}: #{ex.message} (#{ex.class})"
        Stella.ld ex.backtrace
        nil
      end
    end

    def local_ipaddr?(addr)
      addr = IPAddr.new(addr) if String === addr
      ADDR_LOCAL.include?(addr)
    end

    def private_ipaddr?(addr)
      addr = IPAddr.new(addr) if String === addr
      ADDR_CLASSA.include?(addr) ||
      ADDR_CLASSB.include?(addr) ||
      ADDR_CLASSC.include?(addr)
    end

    def ec2_cname_to_ipaddr(cname)
      return unless cname =~ /\Aec2-(\d+)-(\d+)-(\d+)-(\d+)\./
      [$1, $2, $3, $4].join '.'
    end

    def ec2_ipaddr?(addr)
      ec2_us_east_ipaddr?(addr) || ec2_us_west_ipaddr?(addr) ||
      ec2_eu_west_ipaddr?(addr) || ec2_ap_east_ipaddr?(addr)
    end

    def ec2_us_east_ipaddr?(addr)
      ADDR_EC2_US_EAST.each { |ipclass| return true if ipclass.include?(addr) }
      false
    end
    def ec2_us_west_ipaddr?(addr)
      ADDR_EC2_US_WEST.each { |ipclass| return true if ipclass.include?(addr) }
      false
    end
    def ec2_eu_west_ipaddr?(addr)
      ADDR_EC2_EU_WEST.each { |ipclass| return true if ipclass.include?(addr) }
      false
    end
    def ec2_ap_east_ipaddr?(addr)
      ADDR_EC2_AP_EAST.each { |ipclass| return true if ipclass.include?(addr) }
      false
    end

    def hosted_at_ec2?(hostname, region=nil)
      meth = region.nil? ? :ec2_ipaddr? : :"ec2_#{region}_ipaddr?"
      cname = Stella::Utils.cname(hostname)
      if !cname.nil? && cname.first
        addr = Stella::Utils.ec2_cname_to_ipaddr(cname.first)
      else
        addresses = Stella::Utils.ipaddr(hostname) || []
        addr = addresses.first
      end
      addr.nil? ? false : Stella::Utils.send(meth, addr)
    end

    def valid_hostname?(uri)
      begin
        if String === uri
          uri = "http://#{uri}" unless uri.match(/^https?:\/\//)
          uri = URI.parse(uri)
        end
        hostname = Socket.gethostbyname(uri.host).first
        true
      rescue SocketError => ex
        Stella.ld "#{uri.host}: #{ex.message}"
        false
      end
    end

    # Return the external IP address (the one seen by the internet)
    def external_ip_address
      ip = nil
      begin
        %w{solutious.heroku.com/ip}.each do |sponge|
          ipstr = Net::HTTP.get(URI.parse("http://#{sponge}")) || ''
          ip = /([0-9]{1,3}\.){3}[0-9]{1,3}/.match(ipstr).to_s
          break if ip && !ip.empty?
        end
      rescue SocketError, Errno::ETIMEDOUT => ex
        Stella.lc "Connection Error. Check your internets!"
      end
      ip
    end

    # Return the local IP address which receives external traffic
    # from: http://coderrr.wordpress.com/2008/05/28/get-your-local-ip-address/
    # NOTE: This <em>does not</em> open a connection to the IP address.
    def internal_ip_address
      # turn off reverse DNS resolution temporarily
      orig, Socket.do_not_reverse_lookup = Socket.do_not_reverse_lookup, true
      ip = UDPSocket.open {|s| s.connect('75.101.137.7', 1); s.addr.last } # Solutious IP
      ip
    ensure
      Socket.do_not_reverse_lookup = orig
    end

    # <tt>require</tt> a glob of files.
    # * +path+ is a list of path elements which is sent to File.join
    # and then to Dir.glob. The list of files found are sent to require.
    # Nothing is returned but LoadError exceptions are caught. The message
    # is printed to STDERR and the program exits with 7.
    def require_glob(*path)
      begin
        Dir.glob(File.join(*path.flatten)).each do |path|
          require path
        end
      rescue LoadError => ex
        puts "Error: #{ex.message}"
        exit 7
      end
    end


    # <tt>require</tt> a library from the vendor directory.
    # The vendor directory should be organized such
    # that +name+ and +version+ can be used to create
    # the path to the library.
    #
    # e.g.
    #
    #     vendor/httpclient-2.1.5.2/httpclient
    #
    def require_vendor(name, version)
       $:.unshift File.join(Stella::HOME, 'vendor', "#{name}-#{version}")
       require name
    end

    # Same as <tt>require_vendor</tt>, but uses <tt>autoload</tt> instead.
    def autoload_vendor(mod, name, version)
      autoload mod, File.join(Stella::HOME, 'vendor', "#{name}-#{version}", name)
    end

    # Checks whether something is listening to a socket.
    # * +host+ A hostname
    # * +port+ The port to check
    # * +wait+ The number of seconds to wait for before timing out.
    #
    # Returns true if +host+ allows a socket connection on +port+.
    # Returns false if one of the following exceptions is raised:
    # Errno::EAFNOSUPPORT, Errno::ECONNREFUSED, SocketError, Timeout::Error
    #
    def service_available?(host, port, wait=3)
      if Stella.sysinfo.vm == :java
        begin
          iadd = Java::InetSocketAddress.new host, port
          socket = Java::Socket.new
          socket.connect iadd, wait * 1000  # milliseconds
          success = !socket.isClosed && socket.isConnected
        rescue NativeException => ex
          puts ex.message, ex.backtrace if Stella.debug?
          false
        end
      else
        begin
          status = Timeout::timeout(wait) do
            socket = Socket.new( AF_INET, SOCK_STREAM, 0 )
            sockaddr = Socket.pack_sockaddr_in( port, host )
            socket.connect( sockaddr )
          end
          true
        rescue Errno::EAFNOSUPPORT, Errno::ECONNREFUSED, SocketError, Timeout::Error => ex
          puts ex.class, ex.message, ex.backtrace if Stella.debug?
          false
        end
      end
    end

    # Enable string or symbol key access to the nested params hash.
    def indifferent_params(params)
      if params.is_a?(Hash)
        params = indifferent_hash.merge(params)
        params.each do |key, value|
          next unless value.is_a?(Hash) || value.is_a?(Array)
          params[key] = indifferent_params(value)
        end
      elsif params.is_a?(Array)
        params.collect! do |value|
          if value.is_a?(Hash) || value.is_a?(Array)
            indifferent_params(value)
          else
            value
          end
        end
      end
    end
    # Creates a Hash with indifferent access.
    def indifferent_hash
      Hash.new {|hash,key| hash[key.to_s] if Symbol === key }
    end

  end
end

require "stathat"
module Stella::Analytics
  extend self
  def stathat_count name, count=1, wait=0.500
    safely(wait) do
      StatHat::API.ez_post_count(name, Stella.config['vendor.stathat.user'], count)
    end
  end
  def stathat_value name, value, wait=0.500
    safely(wait) do
      StatHat::API.ez_post_value(name, Stella.config['vendor.stathat.user'], value)
    end
  end
  def stathat?
    !Stella.config['vendor.stathat.user'].to_s.empty?
  end
  def safely(wait, &blk)
    return unless stathat?
    begin
      Timeout.timeout(wait) do
        blk.call
      end
    rescue Timeout::Error
      Stella.li '[stathat] timeout (%d)' % wait
    rescue => ex
      Stella.li '[stathat] %s' % ex.message
      Stella.ld ex.backtrace
    end
  end
end

at_exit {
  if defined?(DataObjects)
    # Must be better way to close connection, no? ...
    DataObjects::Pooling.pools.each {|pool| pool.dispose }
  end
  Stella::Logger.close
}
