
class Redis
  autoload :Value, 'redis/value'
  autoload :List, 'redis/set'
  autoload :SortedSet, 'redis/sorted_set'
  autoload :HashKey, 'redis/hash_key'
  autoload :Lock, 'redis/lock'
  autoload :Counter, 'redis/counter'
  autoload :Set, 'redis/set'
end



module Stella::RedisObject
  Stella::RO = self
  @version = 'v3'
  @classes = []
  module ScriptCollector
    attr_reader :version, :classes
    def load_scripts
      scripts = {}
      fs = Dir.glob File.join(Stella::HOME, 'scripts', 'redis', '*.lua')
      fs.each do |path|
        name, sha = load_script(path)
        scripts[name] = sha
        Stella.ld "Loading #{File.basename(path)} (#{sha})"
      end
      scripts
    end
    def load_script path
      script = File.readlines(path).reject { |l| l =~ /\s*\-\-|^\s*$/ }.join
      name = File.basename(path, '.lua')
      sha = self.redis.script 'load', script
      [name, sha]
    end
  end
  extend ScriptCollector
  module ClassMethods
    def included obj
      classes << obj
      obj.extend Stella::RedisObject::ClassMethods
      obj.extend Stella::RedisObject::InstanceIndex
      obj.send :include, Redis::Objects
      obj.send :include, Stella::RedisObject::TimeStamps
      obj.redis_prefix = [Stella::RedisObject.version, obj.keyname].join(':')
      obj.hash_key :object
    end
    def exists? objid
      new(objid).object.exists?
    end
    def load objid
      obj = new(objid)
      if !obj.object.exists?
        raise Stella::MissingItem.new('[%s] %s does not exist'% [objid,name])
      end
      obj
    end
    def create objid, attributes={}
      obj = new(objid)
      if obj.object.exists?
        raise Stella::MissingItem.new('[%s] duplicate %s'% [objid,name])
      end
      now = Stella.now.to_i
      attributes[:objid] = objid
      attributes = {
        :created_at => now,
        :updated_at => now
      }.merge(attributes)
      attributes.each_pair { |n,v| obj[n] = v }
      obj.update_expiration
      index_add objid, attributes[:created_at]
      obj
    end
    def destroy! objid, all=false
      object_names = all ? fields : [:object]
      obj = new(objid)
      object_names.each() { |name| obj.send(name).del }
      index_del objid
    end
    def fields
      redis_objects.collect() { |name, attributes| name }.sort
    end
    def keys
      redis.keys(key('*'))
    end
    def count
      keys.size
    end
    def key *el
      el.flatten!
      el.unshift Stella::RedisObject.version unless el.first =~ /v\d/
      el.compact.join(':').downcase.gsub(/\:\:/, ':')
    end
    def keyname
      @keyname ||= name.to_s.
        sub(%r{(.*::)}, '').
        gsub(/([A-Z]+)([A-Z][a-z])/,'\1_\2').
        gsub(/([a-z\d])([A-Z])/,'\1_\2').
        downcase
    end
    def has_index?
      kind_of? Stella::RedisObject::InstanceIndex
    end
    def redis
      Stella.redis(0, :default)
    end
    attr_writer :expiration,  :db
    def expiration(v=nil)
      (v.nil? || v.to_i.zero?) ? @expiration : self.expiration = v.to_i
    end
    def db(v=nil)
      (v.nil? || v.to_i.zero?) ? @db : self.db = v.to_i
    end
    def get keyname, db=nil
      type = Stella.redis(db).type keyname
      case type
      when "string"
        Redis::Value.new(keyname, Stella.redis(db))
      when "list"
        Redis::List.new(keyname, Stella.redis(db))
      when "set"
        Redis::Set.new(keyname, Stella.redis(db))
      when "zset"
        Redis::SortedSet.new(keyname, Stella.redis(db))
      when "hash"
        Redis::HashKey.new(keyname, Stella.redis(db))
      else
        nil
      end
    end
  end
  extend ClassMethods

  attr_reader :objid
  def initialize objid=nil
    @objid = objid
  end

  def [](key) self.object[key] end
  def []=(key, value) self.object[key] = value end

  def update_expiration(v=nil)
    if v
      self.vars[:ttl] = v
    else
      v = self.vars[:ttl] if self.respond_to?(:vars)
      v ||= self.class.expiration
    end
    fields.each do |name|
      self.send(name).expire v.to_i
    end
  end

  def fields() self.class.fields end

  def keys
    self.class.fields.collect() { |name| send(name).key }.sort
  end

  def ttl
    self.object.ttl
  end

  def destroy! all=false
    self.class.destroy! self.objid, all
  end

  alias_method :id, :objid
end

module Stella::RedisObject::TimeStamps
  def created_age() Stella.now.to_i - (created_at || -1) end
  def created_at() self[:created_at].to_f end
  def updated_age() Stella.now.to_i - (created_at || -1) end
  def updated_at() self[:updated_at].to_f end
  def updated! now=Stella.now.to_i
    self[:updated_at] = now
    update_expiration
  end
end

module Stella::RedisObject::InstanceIndex
  def index_key
    Stella::RedisObject.key(keyname, 'instances')
  end
  def index
    @index ||= Redis::SortedSet.new index_key, redis
  end
  def index_add objid, score=Stella.now.to_i
    index.add objid, score.to_i
  end
  def index_del objid
    index.delete objid
  end
end

module Stella::RedisObject::Vars
  def self.included obj
    obj.hash_key :vars
  end
  def get! name
    name = name.to_s
    vars[name]
  ensure
    vars.delete name
  end
  def get name
    name = name.to_s
    vars[name]
  end
  def set name, value
    name = name.to_s
    vars[name] = value
  end
  def vars!
    vars.all
  ensure
    vars.clear
  end
end


module Stella::Entropy
  extend self
  @values = Redis::Set.new(Stella::RedisObject.key('stella', 'entropy'), Stella.redis(11))
  attr_reader :values
  def pop
    self.values.size > 0 ? self.values.pop : failover
  end
  def clear
    values.clear
    size
  end
  def size
    values.size
  end
  def failover
    [caller[0], rand].gibbler.base(36).shorten(6)
  end
  def populate count=50000
    values.redis.pipelined {
      count.times { self.values.add failover }
    }
    values.size
  end
end

# TODO: Use SecureRandom.uuid
class Stella::Secret
  include Stella::RedisObject
  expiration 30.days
  alias_method :secretid, :objid
  def load_customer
    object[:custid] && Stella::Customer.first(:custid => object[:custid]) || Stella::Customer.anonymous
  rescue => ex
    Stella::Customer.anonymous
  end
  def type? guess
    object[:type].to_s == guess.to_s
  end
  class << self
    def create attributes={}
      attributes = {
        :created_at => Stella.now.to_i
      }.merge(attributes)
      objid = generate_id attributes.values
      super objid, attributes
    end
    def generate_id *entropy
      entropy << Stella::Entropy.pop
      input = [Stella.instance, Stella.now.to_f, self, entropy].join(':')
      #Stella.ld "#{self} id input: #{input}"
      Gibbler.new input
    end
  end
end

class Stella::RangeMetrics
  attr_reader :context, :metric_id, :base_key
  attr_reader :lock, :metrics
  def initialize context, metric_id
    @context, @metric_id = context, metric_id
    @base_key = self.class.key(context, metric_id)
    @lock = Redis::Lock.new self.class.key(base_key, :lock), self.class.redis, :expiration => 30, :timeout => 0.1
    @metrics = Redis::SortedSet.new self.class.key(base_key, :metrics), self.class.redis, :expiration => 7.days
    self.class.ranges.each_pair do |rangeid,range|
      options = {
        :expiration => 7.days,
        :range => range,
        :rangeid => rangeid
      }
      r = Redis::HashKey.new self.class.key(base_key, rangeid), self.class.redis, options
      instance_variable_set("@#{rangeid}", r)
    end
  end
  def range duration, epoint=Stella.now
    r = rangeraw duration, epoint
    #r.collect { |str| Yajl::Parser.parse(str) }
    objects = []
    Yajl::Parser.parse(r.join($/)) { |obj| objects << obj }
    objects
  end
  def rangeraw duration, epoint=Stella.now
    spoint = epoint.to_i-duration.to_i
    metrics.rangebyscore spoint, epoint.to_i
  end
  class << self
    attr_reader :ranges
    attr_accessor :redis_uri
    def key *parts
      Stella::RedisObject.key parts
    end
    def rangeid range
      "#{range.in_hours.to_i}h"
    end
    def rangename range
      case range
      when 1.hours
        "1 hour"
      else
        "#{range.in_hours} hours"
      end
    end
    def redis
      unless @redis
        uri = Stella.config['redis.metrics.uri'] ||
              Stella.config['redis.default.uri']
        Stella.ld "Connecting to #{uri}"
        @redis = Redis.new(:url => uri)
      end
      @redis
    end
  end
  @ranges = {
    :past_1h => 1.hour,
    :past_4h => 4.hours,
    :past_24h => 24.hours
  }.freeze
  # Install accessor methods for all ranges (RangeMetrics#past_1h)
  ranges.each_pair { |rangeid,r| attr_reader rangeid }
  extend Stella::RedisObject::ScriptCollector
end
