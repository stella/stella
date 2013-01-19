require 'stella/app/helpers'


class Stella
  class App
    module Base
      include Stella::App::Helpers

      def publically redirect=nil
        carefully(redirect) do
          check_session!     # 1. Load or create the session, load customer (or anon)
          check_shrimp!      # 2. Check the shrimp for POST,PUT,DELETE (after session)\
          #check_subdomain!  # 3. Check if we're running as a subdomain
          check_referrer!    # 4. Check referrers for public requests
          yield
        end
      end

      def authenticated redirect=nil
        carefully(redirect) do
          check_session!     # 1. Load or create the session, load customer (or anon)
          check_shrimp!      # 2. Check the shrimp for POST,PUT,DELETE (after session)
          #check_subdomain!  # 3. Check if we're running as a subdomain
          sess.authenticated? ? yield : res.redirect(('/')) # TODO: raise OT::Redirect
        end
      end

      def colonels redirect=nil
        carefully(redirect) do
          check_session!     # 1. Load or create the session, load customer (or anon)
          check_shrimp!      # 2. Check the shrimp for POST,PUT,DELETE (after session)
          sess.authenticated? && cust.role?(:colonel) ? yield : res.redirect(('/'))
        end
      end

      def json obj
        res.header['Content-Type'] = "application/json"
        obj.to_json
      end

      def yaml obj
        res.header['Content-Type'] = "application/x-yaml"
        obj.to_yaml
      end

      def csv obj
        res.header['Content-Type'] = "text/plain"
        obj.collect { |o| o.to_csv }
      end

      #def check_subdomain!
      #  subdomstr = req.env['SERVER_NAME'].split('.').first
      #  if !subdomstr.to_s.empty? && subdomstr != 'www' && OT::Subdomain.mapped?(subdomstr)
      #    req.env['ots.subdomain'] = OT::Subdomain.load_by_cname(subdomstr)
      #  elsif cust.has_key?(:cname)
      #    req.env['ots.subdomain'] = cust.load_subdomain
      #  end
      #end

      def check_referrer!
        return if @check_referrer_ran || req.referrer.nil?
        @check_referrer_ran = true
        return if req.referrer.match(Stella.config['site.host'])
        sess[:referrer] ||= req.referrer
      end

      def authentication_required message
        not_found_response message
      end

      def handle_form_error ex, redirect
        sess.set_form_fields ex.form_fields
        sess.add_error_message! ex.message
        res.redirect redirect
      end

      def not_found_response message
        view = Stella::App::Views::NotFound.new req, sess, cust
        view.add_error message
        res.status = 404
        res.body = view.render
      end

      def error_response message
        view = Stella::App::Views::Error.new req, sess, cust
        view.add_error message
        res.status = 500
        res.body = view.render
      end

      def is_subdomain?
        ! req.env['stella.subdomain'].nil?
      end

    end
  end

end


require 'mustache'
class Mustache
  def self.partial(name)
    path = "#{template_path}/#{name}.#{template_extension}"
    if Otto.env?(:dev)
      File.read(path)
    else
      @_partial_cache ||= {}
      @_partial_cache[path] ||= File.read(path)
      @_partial_cache[path]
    end
  end
end


