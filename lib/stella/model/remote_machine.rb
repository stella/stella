class Stella
  class RemoteMachine
    alias_method :objid, :machineid
    def customer? cust
      customer == cust
    end
    def normalize
      update_timestamps
      self.custid ||= customer.custid if self.custid.nil? && customer
      self.machineid ||= gibbler
    end
    def status? *guesses
      guesses.flatten.collect(&:to_s).member?(self.status.to_s)
    end
    class << self
      def destroy! opts={}
        inst = first opts
        inst && inst.destroy!
      end
      def local
        cust = Stella::Customer.anonymous
        opts = {
          :customer => cust, :ipaddress => '127.0.0.1', :hostname => Stella.sysinfo.hostname, :city => :montreal
        }
        @local ||= first_or_create opts
      end
    end
  end

  class WorkerProfile
    alias_method :objid, :workerid
    def remote_machine? m
      remote_machine == m
    end
    def normalize
      update_timestamps
      self.machineid ||= remote_machine.machineid if self.machineid.nil? && remote_machine
      self.workerid ||= gibbler
      true
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


