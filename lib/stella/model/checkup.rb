class Stella

  class Checkup
    alias_method :objid, :checkid
    def update_customer cust
      self.custid = cust.custid
      self.customer = cust
      self.save
    end
    def customer? cust
      customer == cust
    end
    def normalize
      update_timestamps
      self.checkid ||= gibbler
      if host
        self.hostid ||= host.hostid
        self.custid ||= host.custid
      end
      self.custid ||= customer.custid if customer
    end
    def status? *guesses
      guesses.flatten.collect(&:to_s).member?(self.status.to_s)
    end
    class << self
      def destroy! opts={}
        inst = first opts
        inst && inst.destroy!
      end
    end
  end

end


