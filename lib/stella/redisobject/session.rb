

# s = Stella::Session.load ''
class Stella::Session
  include Stella::RedisObject
  include Stella::RedisObject::Vars

  expiration 30.minutes

  value :desc # used for testing
  hash_key :request_params
  list :error_messages
  list :info_messages

  alias_method :sessid, :objid

  def authenticated?
    object[:authenticated] == 'true'
  end

  def request_params!
    request_params.all
  ensure
    request_params.clear
  end

  def load_customer
    object[:custid] && Stella::Customer.first(:custid => object[:custid]) || Stella::Customer.anonymous
  rescue => ex
    Stella.li ex.message
    Stella::Customer.anonymous
  end

  def stale?
    self[:stale] == "true"
  end
  def opera?()            @agent.to_s  =~ /opera/i                      end
  def firefox?()          @agent.to_s  =~ /firefox/i                    end
  def chrome?()          !(@agent.to_s =~ /chrome/i).nil?               end
  def safari?()           (@agent.to_s =~ /safari/i && !chrome?)        end
  def konqueror?()        @agent.to_s  =~ /konqueror/i                  end
  def ie?()               (@agent.to_s =~ /msie/i && !opera?)           end
  def gecko?()            (@agent.to_s =~ /gecko/i && !webkit?)         end
  def webkit?()           @agent.to_s  =~ /webkit/i                     end
  def stella?()           @agent.to_s  =~ /stella/i                     end
  def superfeedr?()       @agent.to_s  =~ /superfeedr/i                 end
  def google?()           @agent.to_s  =~ /google/i                     end
  def yahoo?()            @agent.to_s  =~ /yahoo/i                      end
  def yandex?()           @agent.to_s  =~ /yandex/i                     end
  def baidu?()            @agent.to_s  =~ /baidu/i                      end
  def stella?()           @agent.to_s  =~ /stella/i                     end
  def searchengine?()     google? || yahoo? || yandex? || baidu?        end
  def clitool?()          @agent.to_s  =~ /curl|wget/i  || stella?      end
  def human?()           !searchengine? && !superfeedr? && !clitool? && !stella? end

  def shrimp? guess
    shrimp = object[:shrimp].to_s
    (!shrimp.empty?) && shrimp == guess.to_s
  end
  def add_shrimp
    object[:shrimp] ||= self.class.generate_id(objid, object[:ipaddress], object[:user_agent], :shrimp)
  end
  def clear_shrimp!
    object.delete :shrimp
    nil
  end

  def add_error_message! msg
    error_messages.push msg
  end

  def add_info_message! msg
    info_messages.push msg
  end

  def info_messages!
    info_messages.values
  ensure
    info_messages.clear
  end

  def error_messages!
    error_messages.values
  ensure
    error_messages.clear
  end

  class << self
    def create ipaddress, user_agent, attributes={}
      attributes = {
        :ipaddress => ipaddress,
        :user_agent => user_agent
      }.merge(attributes)
      objid = generate_id attributes.values
      super objid, attributes
    end
    def generate_id *entropy
      entropy << Stella::Entropy.pop
      input = [Stella.instance, Stella.now.to_f, self, entropy].join(':')
      #Stella.ld "session id input: #{input}"
      # Not using gibbler to make sure it's always SHA512
      Digest::SHA512.hexdigest(input).to_i(16).to_s(36) # base-36 encoding
    end
    def redis
      Stella.redis(1)
    end
  end
end
