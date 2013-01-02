require 'stella/app/web'
require 'stella/app/web/views/helpers'


class Stella
  class Email < Mustache
    self.template_path = './templates/email'
    self.view_namespace = Stella::Email
    attr_reader :cust
    def initialize cust, fields={}
      @cust = cust
      fields.each_pair { |k,v| self[k] = v }
    end
    def subject
      self[:subject]
    end
    def send_email
      SendGrid.send_email subject, render, :to => cust.email, :from => 'tucker@blamestella.com', :from_name => 'Tucker (Stella)'
    end
    module Account

      class ExpressConfirmation < Stella::Email
        def subject
          if self[:hostname].to_s.empty?
            "You are now monitoring with BlameStella"
          else
            "%s is now being monitored for downtime" % [self[:hostname]]
          end
        end
      end

      class PasswordReset < Stella::Email
        def subject
          'Password Reset for %s' % [cust.email]
        end
      end

    end
  end
end
