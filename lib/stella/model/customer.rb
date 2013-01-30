require 'data_mapper'
require 'bcrypt'

class Stella
  class Customer

    alias_method :exists?, :saved?
    alias_method :objid, :custid

    def contributor? guess
      self.contributor && self.contributor.to_s == guess.to_s
    end

    def destroy!
      self.contacts.destroy!
      self.hosts.each { |host| host.destroy! }
      self.deleted_at = Stella.now
      self.passhash = nil
      self.github_token = nil
      self.payment_token = nil
      self.nickname = nil
      # And so we don't accidentally email
      self.email = "%s-D-%s" % [self.email, SecureRandom.hex[0..7]]
      self.products.each do |product|
        product.active = false
        product.save
      end
      self.save
    end

    def paying?
      colonel? || comped || !monthly_bill.zero?
    end

    def monitored_hosts
      self.hosts :monitored => true
    end

    def outdated_password
      self.passhashv < 3
    end
    alias_method :outdated_password?, :outdated_password

    def phone?
      !self.phone.to_s.empty?
    end

    def send_sms msg
      raise Stella::NoPhone unless self.phone?
      from = Stella.config['vendor.twilio.phone']
      Twilio::Sms.message(from, self.phone, msg)
    end

    def normalize
      update_timestamps
      self.entropy ||= Stella::Entropy.pop
      self.custid ||= self.gibbler
      self.apikey ||= Gibbler.new(Stella.now.to_f, custid, entropy, :apikey)
      self.external_id ||= Gibbler.new(custid, entropy, :external_id).base(36).shorten(20)
      self.email = self.email.downcase
    end

    def contact
      contacts.first
    end

    def load_session
      Stella::Session.load sessid
    rescue => ex
      Stella.ld ex.message
      nil
    end

    def create_feedback msg
      Stella::Feedback.create :customer => self, :message => msg
    end

    def update_password(newpass)
      if anonymous?
        raise Stella::Problem, "Cannot up password for #{self.email}"
      end
      self.password_at = Time.now.utc
      self.passhash = create_passhash_v3(newpass)
    end
    def password?(guess)
      begin
        BCrypt::Password.new(passhash) == guess
      rescue BCrypt::Errors::InvalidHash => ex
        Stella.ld "[pw-check for #{custid}] #{ex.class}: #{ex.message}: #{ex.message}"
        false
      end
    end
    def create_passhash_v3(guess)
      raise Stella::Problem.new "No digest input" if guess.nil? || guess.empty?
      self.passhashv = 3
      BCrypt::Password.create(guess, :cost => 10).to_s
    end

    def apikey?(guess)
      self.apikey == guess
    end

    def role? guess
      role == guess.to_s.to_sym
    end

    def colonel?
      role? :colonel
    end

    def anonymous?
      role? :anonymous
    end

    #def add_product prodid, discount=0.0
    #  self.purchases
    #end

    def active_products
      self.products :active => true, :order => [ :price.desc, :updated_at.desc ]
    end

    def monthly_bill
      self.comped ? 0 : active_products.collect { |prod| prod.calculated_price }.sum
    end

    class << self
      def anonymous
        email = Stella.config ? Stella.config['account.anonymous.email'] : 'anonymous@blamestella.com'
        @cust ||= first_or_create :email => email, :role => :anonymous
        @cust
      end
      def exists? email
        ! first(:email => email).nil?
      end
      def nickname_exists? nickname
        ! first(:nickname => nickname).nil?
      end
      def valid?(u)
        u = normalize(u)
        u.match(/\A\w+\z/) && u.size <= 16
      end
      def normalize(custid)
        custid.to_s.downcase.strip
      end
      def normalize_mobile(mobile)
        return if mobile.to_s.empty?
        ['+', mobile.gsub(/\D/, '')].join
      end
      def destroy! opts={}
        cust = first opts
        cust && cust.destroy!
      end
      def create *args
        cust = super
        # Make sure the first contact is always themself.
        Stella::Contact.create :email => cust.email, :name => cust.name || cust.nickname, :customer => cust
        cust
      end
    end

  end
end
