
class Stella
  module Model
    module DataField
      class << self
        attr_reader :classes
        def included obj
          @classes ||= []
          (@classes << obj).uniq!
          obj.property :data, DataMapper::Property::Json, :default => {}
        end
      end
    end
    module TimeStamps
      class << self
        attr_reader :classes
        def included obj
          @classes ||= []
          (@classes << obj).uniq!
          obj.property :created_at, Time, :default => (Proc.new() { Stella.now }), :index => true
          obj.property :updated_at, Time, :index => true
          obj.before :save, :update_timestamps
        end
      end
      def update_timestamps
        self.created_at ||= Stella.now
        self.updated_at = Stella.now
      end
    end
    module PerformanceSummary
      attr_reader :classes
      class << self
        def included obj
          @classes ||= []
          (@classes << obj).uniq!
          obj.property :response_time, Float, :default => -1.0
        end
      end
    end
    # Note: assumes that classes that include this module
    # have an objid method that returns a hexadecimal hash.
    module Schedulable
      def starting_point duration=:hour
        modulo = case duration
        when :minute then 5
        when :hour then 55
        when :day then 23
        when :week then 6
        when :month then 28
        else
          raise ArgumentError
        end
        objid.to_i(16) % modulo
      end
      def next duration=:hour, num=1

      end
      class << self
        attr_reader :classes
        def included obj
          @classes ||= []
          (@classes << obj).uniq!
          obj.property :minute_offset,   Integer, :default => (Proc.new() { |r,p| r.starting_point(:minute) })
          obj.property :hour_offset,   Integer, :default => (Proc.new() { |r,p| r.starting_point(:hour) })
          obj.property :day_offset,   Integer, :default => (Proc.new() { |r,p| r.starting_point(:day) })
          obj.property :week_offset,   Integer, :default => (Proc.new() { |r,p| r.starting_point(:week) })
          obj.property :month_offset,   Integer, :default => (Proc.new() { |r,p| r.starting_point(:month) })
        end
      end
    end
  end
  #
  #
  class Customer
    include DataMapper::Resource
    include Gibbler::Complex
    property :id,         Serial, :key => true
    property :custid,     String, :unique_index => true, :required => true
    property :email,      String, :unique_index => true, :required => true
    property :phone,      String, :required => false
    property :role,       Enum[ :anonymous, :colonel, :customer ], :default => :customer
    property :name, String
    property :website, String
    property :company, String
    property :location, String
    property :external_id, String
    property :apikey, String
    property :passhash,   String, :length => 100
    property :passhashv,  Integer, :default => 3
    property :password_at, Time
    property :confirmed_at, Time
    property :srcpartner, String
    property :entropy, String
    property :github_token, String
    property :payment_token, String
    property :testing,     Boolean, :default => false, :required => true
    property :sessid, String, :length => 100
    property :contributor, Enum[ :no, :outlaw, :abider ], :default => :no
    property :contributor_at, Time
    before :valid?, :normalize
    gibbler :email, :role, :entropy, :created_at
    include Stella::Model::Schedulable
    include Stella::Model::PerformanceSummary
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
    property :comped, Boolean, :default => false, :required => true
    property :nickname, String, :unique_index => true
    property :migration_profile, String, :length => 32
    property :legacy, Json, :default => {}
    property :deleted_at, Time
  end

  class Host
    include DataMapper::Resource
    include Gibbler::Complex
    property :id,            Serial, :key => true
    property :hostid,        String, :unique_index => true
    property :custid,        String, :index => true
    property :hostname,      String, :length => 256
    property :monitored,     Boolean, :default => false, :required => true
    property :notify,        Boolean, :default => true, :required => true
    property :settings,      Json, :default => { 'interval' => 5.minutes, 'disable_ga' => true }
    property :hidden,        Boolean, :default => false
    include Stella::Model::Schedulable
    include Stella::Model::PerformanceSummary
    gibbler :custid, :hostname
    before :valid?, :normalize
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class Testplan
    include DataMapper::Resource
    include Gibbler::Complex
    property :id,           Serial, :key => true
    property :planid,       String, :required => true, :unique_index => true
    property :hostid,       String, :required => true
    property :custid,       String, :required => true
    property :uri,          String, :length => 2048
    property :definition,   Json, :default => {}
    property :desc,         String, :length => 255
    property :mode,         Enum[ :phantomjs ], :default => :phantomjs
    property :enabled,      Boolean, :default => false
    property :hidden,       Boolean, :default => false
    property :private,      Boolean, :default => true
    property :ran_at,       Time
    property :thumbnail_at, Time
    gibbler :custid, :hostid, :uri, :definition, :mode, :private
    before :valid?, :normalize
    # NOTE: I've been going back and forth whether to use an offset
    # that's per testplan or per host. I think it makes more sense
    # per plan since that will generate more opportunities to send
    # notifications, Thoughts?
    include Stella::Model::Schedulable
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class Screenshot
    include DataMapper::Resource
    property :id,           Serial, :key => true
    property :objid,        String, :required => true
    property :width,        Integer, :default => 1024
    property :height,       Integer, :default => 768
    property :format,       Enum[ :png ], :default => :png
    property :mode,         Enum[ :web, :mobile ], :default => :web
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class Testrun
    include DataMapper::Resource
    include Gibbler::Complex
    property :id,           Serial, :key => true
    property :runid,        String, :unique_index => true
    property :custid,       String, :index => true
    property :hostid,       String, :required => true
    property :planid,       String, :required => true
    property :result,       Json, :default => {}, :lazy => true
    property :summary,      Json, :default => {}, :lazy => false
    property :private,      Boolean, :default => false
    property :status,       Enum[ :new, :pending, :running, :fubar, :done ], :default => :new
    property :salt,         String, :default => (Proc.new() { Stella::Entropy.pop })
    #property :queue_filter, Json, :default => [], :lazy => false
    gibbler :planid, :custid, :hosts, :mode, :options, :created_at, :salt
    before :valid?, :normalize
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class Checkup
    include DataMapper::Resource
    include Gibbler::Complex
    property :id,           Serial, :key => true
    property :checkid,      String, :required => true, :unique_index => true
    property :custid,       String, :required => true
    property :hostid,       String, :required => true
    property :planid,       String
    property :runid,        String
    property :summary,      Json, :default => {}
    property :status,       Enum[ :new, :pending, :running, :error, :done ], :default => :new
    property :salt,         String, :default => (Proc.new() { Stella::Entropy.pop })
    gibbler :custid, :hostid, :planids, :runids, :created_at, :salt
    before :valid?, :normalize
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class Contact
    include DataMapper::Resource
    include Gibbler::Complex
    property :id,           Serial, :key => true
    property :contactid,    String, :required => true, :unique_index => true
    property :name,         String, :length => 100
    property :email,        String, :length => 64, :required => true
    property :phone,        String, :length => 24
    property :hidden,       Boolean, :default => false
    gibbler :id, :name, :email, :phone, :customer
    before :valid?, :normalize
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class Incident
    include DataMapper::Resource
    property :id,           Serial, :key => true
    property :kind,         Enum[ :error, :timeout, :slowness, :domain ]
    property :status,       Enum[ :new, :detected, :verified, :resolved ], :default => :new, :key => true
    property :detected_at,  Time
    property :verified_at,  Time
    property :resolved_at,  Time
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class Notification
    include DataMapper::Resource
    property :id,           Serial, :key => true
    property :nid,          String, :required => true, :unique_index => true
    property :subject,      String, :length => 255, :required => true
    property :content,      Text, :required => true
    property :summary,      String, :length => 140, :required => true
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class RemoteMachine
    include DataMapper::Resource
    include Gibbler::Complex
    property :id,           Serial, :key => true
    property :machineid,    String, :required => true, :unique_index => true
    property :custid,       String, :required => true
    property :ipaddress,    String, :required => true
    property :hostname,     String, :length => 64, :required => true
    property :name,         String, :length => 100
    property :area,         Enum[ :na_east ], :default => :na_east, :required => true
    property :city,         String
    property :status,       Enum[ :online, :offline ], :default => :online
    property :hidden,       Boolean, :default => false
    gibbler :custid, :name, :hostname, :ipaddress, :location
    before :valid?, :normalize
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class WorkerProfile
    include DataMapper::Resource
    include Gibbler::Complex
    property :id,           Serial, :key => true
    property :workerid,     String, :required => true, :unique_index => true
    property :machineid,    String, :required => true
    property :interval,     Integer, :required => true
    property :status,       Enum[ :online, :offline ], :default => :online
    property :sysinfo,      Json, :default => {}
    gibbler :custid, :name, :sysinfo, :ipaddress, :location, :created_at
    before :valid?, :normalize
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class Product
    include DataMapper::Resource
    property :id,           Serial, :key => true
    property :name,         String, :required => false
    property :prodid,       String, :required => true
    property :price,        Float, :required => true # per month
    property :discount,     Float, :required => true, :default => 0.0 # a percentage, below 1.0
    property :active,       Boolean, :default => true
    property :options,      Json, :default => {}
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
    class << self
      attr_reader :products
      def create cust, prodid, discount=0
        opts = product(prodid)
        super :customer => cust, :name => opts['name'], :prodid => normalize(prodid), :discount => discount, :price => opts['price'], :options => opts
      end
      def add_product prodid, options={}
        @products ||= {}
        prodid = normalize(prodid)
        raise "Product defined #{prodid}" if product?(prodid)
        options['tempid'] = [Stella.instance, prodid].gibbler.short
        options['prodid'] = prodid
        products[prodid] = products[options['tempid']] = options
      end
      def normalize prodid
        prodid.to_s.downcase
      end
      def product prodid
        if !Stella::Product.product?(prodid)
          raise Stella::Problem, "Unknown product: #{prodid}"
        end
        products[normalize(prodid)]
      end
      def product? prodid
        products.member?(normalize(prodid))
      end
      def tempid prodid
        products[normalize(prodid)][:tempid]
      end
      def load!
        add_product :site_free_v1, 'price' => 0.0, 'sites' => 1, 'pages' => 1, 'api' => true, 'interval' => 60.minutes, 'name' => 'Free Monitoring'
        add_product :site_basic_v1, 'price' => 2.0, 'sites' => 1, 'pages' => 3, 'api' => true, 'interval' => 5.minutes, 'name' => 'Basic Monitoring'
        add_product :site_premium_v1, 'price' => 15.0, 'sites' => 1, 'pages' => 3, 'api' => true, 'interval' => 1.minutes, 'name' => 'Premium Monitoring'
      end
      def default
        normalize(:site_free_v1)
      end
    end
    def name
      # This is a fix for records that don't have a name.
      # TODO: Update Product records in the database that don't have name
      super || case self.prodid
      when 'site_free_v1'
        'Free Monitoring'
      when 'site_basic_v1'
        'Basic Monitoring'
      when 'site_premium_v1'
        'Premium Monitoring'
      end
    end
    def prodid? guess
      prodid == self.class.normalize(guess)
    end
    def tempid
      self.class.tempid prodid
    end
    def calculated_price
      (price * (1-discount)).to_i
    end
    def paid?
      price > 0.0
    end
    def free?
      !paid?
    end
  end

  class BillingStatement
    include DataMapper::Resource
    property :id,           Serial, :key => true
    property :amount,       Float, :required => true
    property :paid,         Boolean, :default => false
    property :due_at,       Time
    property :paid_at,      Time
    def due?
      @due ||= (Stella.now.to_i-due_at) > 0
    end
    def paid?
      @paid ||= (Stella.now.to_i-paid_at) > 0
    end
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class DailyUsage
    include DataMapper::Resource
    property :id,           Serial, :key => true
    property :amount,       Float, :required => true
    include Stella::Model::TimeStamps
    include Stella::Model::DataField
  end

  class Feedback
    include DataMapper::Resource
    property :id,           Serial, :key => true
    property :message,      String, :required => true
    property :reply,        String, :required => false
    property :viewed_at,    Time
    property :replied_at,   Time
    include Stella::Model::TimeStamps
    def reply! reply
      self.reply = reply
      send.replied_at Stella.now
      save
    end
  end

  require 'stella/model/customer'
  require 'stella/model/host'
  require 'stella/model/checkup'
  require 'stella/model/remote_machine'
  require 'stella/model/billing'
end

## RELATIONSHIPS
class Stella
  class Customer
    has n, :hosts
    has n, :testplans
    has n, :testruns
    has n, :checkups
    has n, :contacts
    has n, :remote_machines
    has n, :products
    has n, :billing_statements
    has n, :daily_usage
    has n, :feedbacks
    #has n, :incidents
  end
  class Host
    has n, :testplans
    has n, :contacts, :through => Resource
    has n, :checkups
    has n, :testruns
    has n, :screenshots
    #has n, :incidents
    belongs_to :customer, :required => true
    belongs_to :product, :required => false
  end
  class Testplan
    has n, :testruns
    has n, :checkups
    has n, :screenshots
    #has n, :incidents
    belongs_to :host, :required => true
    belongs_to :customer, :required => false
  end
  class Testrun
    belongs_to :customer, :required => false
    belongs_to :testplan, :required => false
    belongs_to :remote_machine, :required => false
    belongs_to :host, :required => true
  end
  class Checkup
    has n, :screenshots
    belongs_to :host, :required => true
    belongs_to :customer, :required => false
    belongs_to :testplan, :required => false
  end
  class Contact
    has n, :hosts, :through => Resource
    belongs_to :customer, :required => true
  end
  class RemoteMachine
    has n, :worker_profiles
    belongs_to :customer, :required => true
  end
  class WorkerProfile
    belongs_to :remote_machine, :required => true
  end
  class Screenshot
    belongs_to :testrun, :required => false
    belongs_to :checkup, :required => false
    belongs_to :host, :required => false
    belongs_to :testplan, :required => false
  end
  #class Incident
  #  belongs_to :testplan, :required => true
  #  belongs_to :host, :required => true
  #  has n, :testruns
  #end
  class Product
    belongs_to :customer, :required => true
  end
  class Feedback
    belongs_to :customer, :required => true
  end
end

DataMapper::Model.raise_on_save_failure = true
DataMapper.finalize  # must be called after all models are loaded

