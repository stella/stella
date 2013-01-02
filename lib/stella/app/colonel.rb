require 'stella/app/web/base'
require 'stella/app/colonel/views'

class Stella::App

  class Colonel
    include Base

    def index
      colonels do
        view = Stella::App::Colonel::Views::Dashboard.new req, sess, cust, req.params
        res.body = view.render
      end
    end

    def debug
      res.header['Content-Type'] = "text/plain"
      colonels do
        content = []
        content << "---  STELLA v#{Stella::VERSION}  ------------------------------------------"
        content << "[%d/%s] %s %s-%s @ %s" % [$$, Stella.instance.short,
          Stella.mode, Stella.sysinfo.vm, Stella.sysinfo.ruby.join('.'), Time.now.utc]
        content << "--------------------------------------------------------------"
        content << ''
        DataMapper::Model.descendants.entries.each do |model|
          instances = model.all
          content << '%s (%d):' % [model.to_s, instances.size]
          instances.each do |obj|
            content << obj.to_json
          end
          content << ''
        end
        res.body = content.join $/
      end
    end

    def customers
      colonels do
        if req.params[:q]
          q = req.params[:q].strip
          thiscust = Stella::Customer.first :email.like => q
          thiscust ||= Stella::Customer.first :nickname.like => q
          thiscust ||= Stella::Customer.first :custid => q
        end
        view = Stella::App::Colonel::Views::Customers.new req, sess, cust, thiscust
        res.body = view.render
      end
    end

    def hosts
      colonels do
        if req.params[:q]
          q = req.params[:q].strip
          thishost = Stella::Host.first :hostname.like => q
          thishost ||= Stella::Host.first :hostid => q
        end
        view = Stella::App::Colonel::Views::Hosts.new req, sess, cust, thishost
        res.body = view.render
      end
    end

    def redump
      colonels do
        if req.params[:db]
          db = req.params[:db].to_i
          sess.vars[:redis_db] = db
        else
          db = (sess.vars[:redis_db] || 1).to_i
        end
        selected_db = Stella.redis(db)
        key = req.params[:key] unless req.params[:key].to_s.empty?
        query = req.params[:q] unless req.params[:q].to_s.empty?
        databases = (0..15).to_a.collect { |idx| Stella.redis_connection[idx] }.compact
        view = Stella::App::Colonel::Views::Redump.new req, sess, cust
        view.databases = databases
        view.selected_db = selected_db
        view.query = query
        view.key = key
        view.keys = selected_db.keys("*#{query}*").slice(0, 100)
        if !key.to_s.empty?
          view.value = Stella::RedisObject.get(key, db)
          view.type = selected_db.type key
          view.realttl = selected_db.ttl key
        end
        res.body = view.render
      end
    end


    def queues
      colonels do
        view = Stella::App::Colonel::Views::Queues.new req, sess, cust
        view.queues = Stella::SmartQueue.queue_priority([req.params[:q]]).select { |q| ! q.list.empty? }
        view.notches = Stella::SmartQueue.notches([req.params[:q]], Stella.now+1.hour, 120).select { |q| ! q.list.empty? }
        res.body = view.render
      end
    end

  end

end

module Stella::App::Colonel::Views
  class Queues < Stella::App::Colonel::View
    attr_accessor :queues ,:notches
    def init
      @title ="Queues"
    end
  end
  class Redump < Stella::App::Colonel::View
    attr_accessor :databases, :selected_db, :key, :value, :type, :realttl, :keys, :query
    def init
      @title ="Redump"
    end
    def redisinfo
      selected_db.info.to_yaml
    end
    def display_value
      return unless value
      case value
      when Redis::Value
        value.to_s
      when Redis::List
        value.range(0, -1) || []
      when Redis::Set
        value.members || []
      when Redis::SortedSet
        value.range(0, -1) || []
      when Redis::HashKey
        value.all || {}
      else
        ''
      end.to_yaml
    end
  end

  class Dashboard < Stella::App::Colonel::View
    attr_reader :duration
    def init *args
      @title = "Dashboard"
      colonel_vars if respond_to?(:colonel_vars)
    end
  end

  class Customers < Stella::App::Colonel::View
    attr_reader :duration
    attr_accessor :feedbacks
    def init thisobj
      @title = "Customers"
      colonel_vars if respond_to?(:colonel_vars)
      self[:customer_count] = Stella::Customer.count
      self[:recent_customers] = Stella::Customer.all :created_at.gt => Time.now-30.days, :order => [:created_at.desc]
      if thisobj
        self[:thiscust] = thisobj
        self[:their_sites] = thisobj.hosts(:hidden => false, :order => [ :monitored.desc, :hostname ])
        self[:their_sites_count] = self[:their_sites].size
        self[:their_monitored_count] = self[:their_sites].select { |h| h.monitored }.size
        self[:has_sites] = ! self[:their_sites_count].zero?
        self[:feedbacks] = thisobj.feedbacks :order => [ :created_at.desc ], :limit => 25
      else
        self[:feedbacks] = Stella::Feedback.all :created_at.gt => Time.now-14.days, :order => [ :created_at.desc ]
      end
    end
  end

  class Hosts < Stella::App::Colonel::View
    attr_reader :duration
    attr_accessor :feedbacks
    def init thisobj
      @title = "Hosts"
      colonel_vars if respond_to?(:colonel_vars)
      self[:hosts_count] = Stella::Host.count
      self[:recent_hosts] = Stella::Host.all :updated_at.gt => Time.now-30.days, :order => [:updated_at.desc], :limit => 25
      if thisobj
        self[:thishost] = thisobj
      else
      end
    end
  end

end
