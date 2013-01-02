

class Stella
  class Problem < RuntimeError
    def initialize(*args)
      @args = args.flatten.compact
    end
  end
  class DuplicateItem < Stella::Problem
  end
  class MissingItem < Stella::Problem
  end
  class LocalDomainError < Stella::Problem
    def host() @args[0] end
    def user() @args[1] end
    def ipaddress() @args[2] end
    def message() "#{host} looks like an internal IP address!" end
    def report
      "#{self.class}: #{host} #{user} #{ipaddress}"
    end
  end
  class UnknownHostname < Stella::Problem
    attr_reader :host
    def initialize host
      @host = host
    end
    def message
      "Unable to resolve \"#{host}\""
    end
  end
  class NoRun < Stella::Problem
  end
  class NoPlan < Stella::Problem
  end
  class UnknownCustomer < Stella::Problem
  end
  class Limited < Stella::Problem
  end
  class NoRedis < Stella::Problem
    attr_reader :uri
    def initialize uri
      @uri = uri
    end
    def message
      "No Redis @ #{uri}"
    end
  end
  class NoMetrics < Stella::Problem
  end
end
