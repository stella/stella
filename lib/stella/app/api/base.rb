require 'stella/app/helpers'

class Stella::App
  class API
    module Base
      include Stella::App::Helpers

      def publically
        carefully do
          yield
        end
      end

      # curl -F 'ttl=7200' -u 'delano@onetimesecret.com:4eb33c6340006d6607c813fc7e707a32f8bf5342' http://www.ot.com:7143/api/v1/generate
      def authenticated allow_anonymous=false
        carefully do
          success = false
          req.env['otto.auth'] ||= Rack::Auth::Basic::Request.new(req.env)
          auth = req.env['otto.auth']
          if auth.provided?
            raise Unauthorized unless auth.basic?
            email, apikey = *(auth.credentials || [])
            raise Unauthorized if email.to_s.empty? || apikey.to_s.empty?
            possible = Stella::Customer.first :email => email
            raise Unauthorized if possible.nil?
            @cust = possible if possible.apikey?(apikey)
            unless cust.nil? || @sess = cust.load_session
              @sess = Stella::Session.create req.client_ipaddress, req.user_agent, :custid => cust.custid
            end
            sess[:authenticated] = true unless sess.nil?
          #elsif req.cookie?(:sess) && Stella::Session.exists?(req.cookie(:sess))
          #  #check_session!
          #  raise Unauthorized, "No session support"
          elsif !allow_anonymous
            raise Unauthorized, "No session or credentials"
          else
            @cust = Stella::Customer.anonymous
            @sess = Stella::Session.create req.client_ipaddress, req.user_agent, :custid => cust.custid
          end
          if cust.nil? || sess.nil? #|| cust.anonymous? && !sess.authenticated?
            raise Unauthorized, "[bad-cust] '#{email}' via #{req.client_ipaddress}"
          else
            cust.sessid = sess.sessid unless cust.anonymous?
            yield
          end
        end
      end

      def content hsh
        json hsh
      end

      def handle_form_error ex, redirect
        error_response ex.message
      end

      def secret_not_found_response
        not_found_response "Unknown secret", :secret_key => req.params[:key]
      end

      def authentication_required msg, hsh={}
        hsh[:code], hsh[:msg] = 401, msg
        res.header['WWW-Authenticate'] = 'Basic realm="Authorization required"'
        res.status = hsh[:code]
        json hsh
      end

      def not_found_response msg, hsh={}
        hsh[:code], hsh[:msg] = 404, msg
        res.status = hsh[:code]
        json hsh
      end

      def error_response msg, hsh={}
        hsh[:code], hsh[:msg] = 404, msg
        res.status = hsh[:code]
        json hsh
      end

    end
  end
end
