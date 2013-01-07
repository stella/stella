#encoding: utf-8

$KCODE = "u" if RUBY_VERSION =~ /^1.8/

module QuantizeTime
  def quantize quantum
    stamp = self === Integer ? self : to_i
    Time.at(stamp - (stamp % quantum)).utc
  end
  def on_the_next quantum
    Time.at(quantize(quantum)+quantum).utc
  end
  def on_the_previous quantum
    Time.at(quantize(quantum)-quantum).utc
  end
  def on_the quantum
    Time.at(quantize(quantum)).utc
  end
  def quantized_range quantum, epoint
    spoint = quantize(quantum)
    epoint = epoint.quantize(quantum)
    spoint, epoint = epoint, spoint if epoint < spoint
    range = []
    while spoint <= epoint
      range << spoint
      spoint += quantum
    end
    range
  end
end
module QuantizeInteger
  def quantize quantum
    stamp = self === Integer ? self : to_i
    stamp - (stamp % quantum)
  end
  def on_the_next quantum
    quantize(quantum)+quantum
  end
  def on_the_previous quantum
    quantize(quantum)-quantum
  end
  def on_the quantum
    quantize(quantum)
  end
  def quantized_range quantum, epoint
    spoint = quantize(quantum)
    epoint = epoint.quantize(quantum)
    spoint, epoint = epoint, spoint if epoint < spoint
    range = []
    while spoint <= epoint
      range << spoint
      spoint += quantum
    end
    range
  end
end

class Time
  include QuantizeTime
  def to_natural
    to_i.to_natural
  end
  def to_ymd
    self.strftime("%Y-%m-%d")
  end
  def to_date
    self.strftime("%a %b %d, %Y")
  end
  def to_datetime
    self.strftime("%a %b %d, %Y %H:%M UTC")
  end
end

class Integer
  include QuantizeInteger
end
class Fixnum
  include QuantizeInteger
end

class Symbol
  unless method_defined?(:empty?)
    def downcase
      self.to_s.downcase.to_sym
    end
    def upcase
      self.to_s.upcase.to_sym
    end
    def empty?
      self.to_s.empty?
    end
  end
end

# Fix for eventmachine in Ruby 1.9
class Thread
  unless method_defined? :kill!
    def kill!(*args) kill( *args) end
  end
end


# Assumes Time::Units and Numeric mixins are available.
class String
  def in_seconds
    # "60m" => ["60", "m"]
    q,u = self.scan(/([\d\.]+)([s,m,h])?/).flatten
    q &&= q.to_f and u ||= 's'
    q &&= q.in_seconds(u)
  end
end


class String
  def encode_fix(enc="UTF-8")
    if RUBY_VERSION >= "1.9"
      begin
        encode!(enc, :undef => :replace, :invalid => :replace, :replace => '?')
      rescue Encoding::CompatibilityError
        BS.info "String#encode_fix: resorting to US-ASCII"
        encode!("US-ASCII", :undef => :replace, :invalid => :replace, :replace => '?')
      end
    end
    self
  end
  def plural(int=1)
    int > 1 || int.zero? ? "#{self}s" : self
  end
  def shorten(len=50)
    return self if size <= len
    [self[0..(len-1)], "..."].join
  end
  def to_file(filename, mode, chmod=0744)
    mode = (mode == :append) ? 'a' : 'w'
    f = File.open(filename,mode)
    f.puts self
    f.close
    raise "Provided chmod is not a Fixnum (#{chmod})" unless chmod.is_a?(Fixnum)
    File.chmod(chmod, filename)
  end

  # via: http://www.est1985.nl/design/2-design/96-linkify-urls-in-ruby-on-rails
  def linkify!
    self.gsub!(/\b((https?:\/\/|ftps?:\/\/|mailto:|www\.|status\.)([A-Za-z0-9\-_=%&amp;@\?\.\/]+(\/\s)?))\b/) {
      match = $1
      tail  = $3
      case match
      when /^(www|status)/     then  "<a href=\"http://#{match.strip}\">#{match}</a>"
      when /^mailto/  then  "<a href=\"#{match.strip}\">#{tail}</a>"
      else                  "<a href=\"#{match.strip}\">#{match}</a>"
      end
    }
    self
  end

  def linkify
     self.dup.linkify!
  end

end


unless defined?(Time::Units)
  class Time
    module Units
      PER_MICROSECOND = 0.000001.freeze
      PER_MILLISECOND = 0.001.freeze
      PER_MINUTE = 60.freeze
      PER_HOUR = 3600.freeze
      PER_DAY = 86400.freeze

      def microseconds()    seconds * PER_MICROSECOND     end
      def milliseconds()    seconds * PER_MILLISECOND    end
      def seconds()         self                         end
      def minutes()         seconds * PER_MINUTE          end
      def hours()           seconds * PER_HOUR             end
      def days()            seconds * PER_DAY               end
      def weeks()           seconds * PER_DAY * 7           end
      def years()           seconds * PER_DAY * 365        end

      def in_years()        seconds / PER_DAY / 365      end
      def in_weeks()        seconds / PER_DAY / 7       end
      def in_days()         seconds / PER_DAY          end
      def in_hours()        seconds / PER_HOUR          end
      def in_minutes()      seconds / PER_MINUTE         end
      def in_milliseconds() seconds / PER_MILLISECOND    end
      def in_microseconds() seconds / PER_MICROSECOND   end

      def in_time
        Time.at(self).utc
      end

      def in_seconds(u=nil)
        case u.to_s
        when /\A(y)|(years?)\z/
          years
        when /\A(w)|(weeks?)\z/
          weeks
        when /\A(d)|(days?)\z/
          days
        when /\A(h)|(hours?)\z/
          hours
        when /\A(m)|(minutes?)\z/
          minutes
        when /\A(ms)|(milliseconds?)\z/
          milliseconds
        when /\A(us)|(microseconds?)|(μs)\z/
          microseconds
        else
          self
        end
      end

      def to_natural
        val = Time.now.utc.to_i - self.to_i
        if val < 10
          result = 'a moment ago'
        elsif val < 40
          result = 'about ' + (val * 1.5).to_i.to_s.slice(0,1) + '0 seconds ago'
        elsif val < 60
          result = 'about a minute ago'
        elsif val < 60 * 1.3
          result = "1 minute ago"
        elsif val < 60 * 2
          result = "2 minutes ago"
        elsif val < 60 * 50
          result = "#{(val / 60).to_i} minutes ago"
        elsif val < 3600 * 1.4
          result = 'about 1 hour ago'
        elsif val < 3600 * (24 / 1.02)
          result = "about #{(val / 60 / 60 * 1.02).to_i} hours ago"
        elsif val < 3600 * 24 * 1.6
          result = Time.at(self.to_i).strftime("yesterday").downcase
        elsif val < 3600 * 24 * 7
          result = Time.at(self.to_i).strftime("on %A").downcase
        elsif val.in_days > 60
          months = (val.in_days/30).to_i
          result = "#{months} #{'month'.plural(months)} ago"
        else
          weeks = val.in_weeks
          result = "#{weeks} #{'week'.plural(weeks)} ago"
        end
        result
      end

      ## JRuby doesn't like using instance_methods.select here.
      ## It could be a bug or something quirky with Attic
      ## (although it works in 1.8 and 1.9). The error:
      ##
      ##  lib/attic.rb:32:in `select': yield called out of block (LocalJumpError)
      ##  lib/stella/mixins/numeric.rb:24
      ##
      ## Create singular methods, like hour and day.
      # instance_methods.select.each do |plural|
      #   singular = plural.to_s.chop
      #   alias_method singular, plural
      # end

      alias_method :ms, :milliseconds
      alias_method :'μs', :microseconds
      alias_method :second, :seconds
      alias_method :minute, :minutes
      alias_method :hour, :hours
      alias_method :day, :days
      alias_method :week, :weeks
      alias_method :year, :years

    end
  end

  class Numeric
    include Time::Units

    def to_ms
      (self*1000.to_f)
    end

    # TODO: Use 1024?
    def to_bytes
      args = case self.abs.to_i
      when (1000)..(1000**2)
        '%3.2f%s' % [(self / 1000.to_f).to_s, 'kb']
      when (1000**2)..(1000**3)
        '%3.2f%s' % [(self / (1000**2).to_f).to_s, 'mb']
      when (1000**3)..(1000**4)
        '%3.2f%s' % [(self / (1000**3).to_f).to_s, 'gb']
      when (1000**4)..(1000**6)
        '%3.2f%s' % [(self / (1000**4).to_f).to_s, 'tb']
      else
        [self.to_i, 'bytes'].join
      end
    end
  end
end


#############################
# Statistics Module for Ruby
# (C) Derrick Pallas
#
# Authors: Derrick Pallas
# Website: http://derrick.pallas.us/ruby-stats/
# License: Academic Free License 3.0
# Version: 2007-10-01b
#

class Numeric
  def square ; self * self ; end
  def fineround(len=6.0)
    v = (self * (10.0**len)).round / (10.0**len)
    v.zero? ? 0 : v
  end
end

class Array
  def sum ; self.inject(0){|a,x| next if x.nil? || a.nil?; x+a} ; end
  def mean; self.sum.to_f/self.size ; end
  def median
    case self.size % 2
      when 0 then self.sort[self.size/2-1,2].mean
      when 1 then self.sort[self.size/2].to_f
    end if self.size > 0
  end
  def histogram ; self.sort.inject({}){|a,x|a[x]=a[x].to_i+1;a} ; end
  def mode
    map = self.histogram
    max = map.values.max
    map.keys.select{|x|map[x]==max}
  end
  def squares ; self.inject(0){|a,x|x.square+a} ; end
  def variance ; self.squares.to_f/self.size - self.mean.square; end
  def deviation ; Math::sqrt( self.variance ) ; end
  alias_method :sd, :deviation
  def permute ; self.dup.permute! ; end
  def permute!
    (1...self.size).each do |i| ; j=rand(i+1)
      self[i],self[j] = self[j],self[i] if i!=j
    end;self
  end
  def sample n=1 ; (0...n).collect{ self[rand(self.size)] } ; end

  def random
    self[rand(self.size)]
  end
  def percentile(perc)
    self.sort[percentile_index(perc)]
  end
  def percentile_index(perc)
    (perc * self.length).ceil - 1
  end
end


class Array
  def dump(format)
    respond_to?(:"to_#{format}") ? send(:"to_#{format}") : raise("Unknown format: #{format}")
  end

  def to_json
    Yajl::Encoder.encode(self)
  end
  def self.from_json(str)
    Yajl::Parser.parse(str, :check_utf8 => false)
  end
end

class Float

  # Returns true if a float has a fractional part; i.e. <tt>f == f.to_i</tt>
  def fractional_part?
    fractional_part != 0.0
  end

  # Returns the fractional part of a float. For example, <tt>(6.67).fractional_part == 0.67</tt>
  def fractional_part
    (self - self.truncate).abs
  end

end


class Hash

  def self.from_json(str)
    Yajl::Parser.parse(str, :check_utf8 => false)
  end

  unless method_defined?(:to_json)
    def to_json(*args)
      Yajl::Encoder.encode(self)
    end
  end

  # Courtesy of Julien Genestoux
  def flatten
    params = {}
    stack = []

    each do |k, v|
      if v.is_a?(Hash)
        stack << [k,v]
      elsif v.is_a?(Array)
        stack << [k,Hash.from_array(v)]
      else
        params[k] =  v
      end
    end

    stack.each do |parent, hash|
      hash.each do |k, v|
        if v.is_a?(Hash)
          stack << ["#{parent}[#{k}]", v]
        else
          params["#{parent}[#{k}]"] = v
        end
      end
    end

    params
  end

  def dump(format)
    respond_to?(:"to_#{format}") ? send(:"to_#{format}") : raise("Unknown format")
  end

  # Courtesy of Julien Genestoux
  # See: http://stackoverflow.com/questions/798710/how-to-turn-a-ruby-hash-into-http-params
  # NOTE: conflicts w/ HTTParty 0.7.3 when named "to_params"
  def to_http_params
    params = ''
    stack = []

    each do |k, v|
      if v.is_a?(Hash)
        stack << [k,v]
      elsif v.is_a?(Array)
        stack << [k,Hash.from_array(v)]
      else
        params << "#{k}=#{v}&"
      end
    end

    stack.each do |parent, hash|
      hash.each do |k, v|
        if v.is_a?(Hash)
          stack << ["#{parent}[#{k}]", URI::Escape.escape(v)]
        else
          params << "#{parent}[#{k}]=#{URI::Escape.escape(v)}&"
        end
      end
    end

    params.chop!
    params
  end
  def self.from_array(array = [])
    h = Hash.new
    array.size.times do |t|
      h[t] = array[t]
    end
    h
  end

  # Return a hash that includes everything but the given keys. This is useful for
  # limiting a set of parameters to everything but a few known toggles:
  #
  #   @person.update_attributes(params[:person].except(:admin))
  #
  # If the receiver responds to +convert_key+, the method is called on each of the
  # arguments. This allows +except+ to play nice with hashes with indifferent access
  # for instance:
  #
  #   {:a => 1}.with_indifferent_access.except(:a)  # => {}
  #   {:a => 1}.with_indifferent_access.except("a") # => {}
  #
  def except(*keys)
    dup.except!(*keys)
  end
  # Replaces the hash without the given keys.
  def except!(*keys)
    keys.each { |key| delete(key) }
    self
  end
  def allow(*keys)
    dup.allow!(*keys)
  end
  # Replaces the hash without the given keys.
  def allow!(*keys)
    keys = self.keys-keys
    keys.each { |key| delete(key) }
    self
  end
end


# Since rack 1.4, Rack::Reloader doesn't actually reload.
# A new instance is created for every request, so the cached
# modified times are reset every time.
# This patch uses a class variable for the @mtimes hash
# instead of an instance variable.
module Rack
  class Reloader
    @mtimes = {}
    class << self
      attr_reader :mtimes
    end
    def reload!(stderr = $stderr)
      rotation do |file, mtime|
        previous_mtime = self.class.mtimes[file] ||= mtime
        safe_load(file, mtime, stderr) if mtime > previous_mtime
      end
    end
    def safe_load(file, mtime, stderr = $stderr)
      load(file)
      stderr.puts "#{self.class}: reloaded `#{file}'"
      file
    rescue LoadError, SyntaxError => ex
      stderr.puts ex
    ensure
      self.class.mtimes[file] = mtime
    end
  end
end
