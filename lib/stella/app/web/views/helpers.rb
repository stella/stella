

module Stella::App::Views::Helpers
  module Common
    def obscure_email(text)
      text.to_s.encode_fix("ISO-8859-1").gsub /(\b[A-Z0-9._%-]+(@[A-Z0-9.-]+\.[A-Z]{2,4}\b))/i, "*******\\2"
    end
    def current_time
      n = Time.now.utc
      { :year => n.year }
    end
    def ahref uri, text, css=nil, title=nil
      { :uri => uri, :text => text, :title => title, :css => css }
    end
    def jsvar name, value
      value = case value.class.to_s
      when 'String', 'Gibbler::Digest', 'Symbol'
        "'#{Rack::Utils.escape_html(value)}'"
      when 'Array'
        value.inspect
      when 'Hash'
        "jQuery.parseJSON('#{value.to_json}')"
      when 'NilClass'
        'null'
      else
        value
      end
      { :name => name, :value => value }
    end
    def pretty_ms(v)
      return 0 if v.nil? || Float === v && v.nan?
      v < 1 ? v.fineround(2) : v.to_i
    end
    def pretty_percent(v)
      return 0 if v.nil? || Float === v && v.nan?
      v = v * 100
      v.to_i.zero? ? ('%.1f' % v) : v.to_i
    end

    def pretty_params(params)
      #params.delete( :__stella) || params.delete( '__stella')
      return '' if params.empty?
      '?' << params.to_params
    end
    def pretty_headers(headers)
      return '' if headers.empty?
      h = []
      headers.each { |pair| h << "%s: %s" % pair }
      h.join $/
    end
    def baseuri
      scheme = Stella.config ? Stella.config['site.scheme'] : 'https'
      server = Stella.config ? Stella.config['site.host'] : 'www.blamestella.com'
      ret = '%s://%s' % [scheme, server]
      ret << ':%d' % Stella.config['site.port'] if ![80, 443].member?(Stella.config['site.port'].to_i)
      ret
    end
    def jsonp payload, func=nil
      func = 'handleResponse' if func.to_s.empty?
      output = "// %s?callback=%s\n%s(%s)" % [req.current_absolute_uri, func, func, payload]
    end
    def add_shrimp
      '<input type="hidden" name="shrimp" value="%s" />' % [sess.add_shrimp]
    end
    def secure?
      # X-Scheme is set by nginx
      # X-FORWARDED-PROTO is set by elastic load balancer
      (req.env['HTTP_X_FORWARDED_PROTO'] == 'https' || req.env['HTTP_X_SCHEME'] == "https")
    end

    def local?
      return if req.nil?
      (Stella::App::LOCAL_HOSTS.member?(req.env['SERVER_NAME']) && (
        req.client_ipaddress == '127.0.0.1' ||
       !req.client_ipaddress.match(/^10\.0\./).nil? ||
       !req.client_ipaddress.match(/^192\.168\./).nil?))
    end
    def determine_incident_class(count)
      case count
      when 0..0
        :pass
      when 1..2
        :warn
      else
        :fail
      end
    end
  end

  module URIHelpers
    # View/Change subscription (customer-facing)
    def spreedly_subscription(cust)
      uri = ['https://spreedly.com', Stella.conf[:spreedly][:site_name],
        'subscriber_accounts', cust.spreedly.value].join('/')
    end

    # View subscriber (spreedly admin)
    def spreedly_subscriber_admin(cust)
      uri = ['https://spreedly.com', Stella.conf[:spreedly][:site_name],
        'subscribers', cust.external_id, cust.custid].join('/')
    end
    def uri(*path)
      [baseuri, uri_path(*path)].join
    end
    def uri_path *args
      args.unshift '' # force a leading slash
      str = args.flatten.join('/')
      str.gsub /\/\//, '/'
    end
  end
  module ThirdParty

    def gravatar_prefix
      prefix = 'https://secure'
      [prefix, '.gravatar.com/avatar/'].join
    end
    def gravatar(email)
      return '/img/stella.png' if email.to_s.empty?
      suffix = Digest::MD5.hexdigest email.downcase
      prefix = 'https://secure'
      [prefix, '.gravatar.com/avatar/', suffix].join
    end

    def bitly(uri)

      bitly = Bitly.new("blamestella", "R_dd3d9ed03c3260226438678a98a13876")
      bitly.shorten(uri).short_url
    rescue => ex
      Stella.li "Bitly error: #{ex.message}"
      ""
    end
  end
  module SyntaxHighlighter
    #require 'coderay'
    unless defined?(SyntaxHighlighter::LEXERS)
      LEXERS = %w( ruby javascript python scheme html xml json yaml css diff )
      LEXERS.each do |lexer|
        define_method "highlight_#{lexer}" do
          lambda { |text| render CodeRay.scan(text, lexer).html }
        end
      end
    end
  end
  module DateTime
    def newsdateiso(e)
    end

    def newstime(e)
      #adjusted = e#-(113.years+27.days).to_i # 1897 has the same calendar as 2010
      # NOTE: 32-bit versions of Ruby give an error (i.e. on linode):
      #           RangeError: bignum too big to convert into `long'
      # so the date is hardcoded for now. TODO
      #t = Time.at adjusted.to_i
      t = Time.at e.to_i
      year = t.year - 113
      t.utc.strftime("%a, %b %d #{year} %I:%M%p")
    end

    def newsdate(e)
      t = Time.at e.to_i
      year = t.year - 113
      t.utc.strftime("%a, %b %d #{year}")
    end

    def texttime(e)
      t = Time.at e.to_i
      t.utc.strftime("%a, %b %d %Y %I:%M%p UTC")
    end

    def xmldate(e)
      t = Time.at(e).utc
      t.strftime("%Y-%m-%dT%H:%M:%S")
    end

    def hours_ago(e)
      return if e.nil?
      val = Time.now.utc.to_i - e
      hours = (val.to_f / 60 / 60 * 1.02)
      mins = (hours*60).to_i
      hours < 1 ? "#{mins} #{'minute'.plural(mins)} ago" : "#{hours.to_i} #{'hour'.plural(hours)} ago"
    end

    def jsdate(e)
      #2010-09-30T10:24:05-07:00
      t = Time.at(e).utc
      t.strftime("%Y-%m-%dT%H:%M:%S")
    end

    def natural_time(e)
      return if e.nil?
      val = Stella.now.to_i - e
      val.to_natural
    end

    def epochdate(e)
      t = Time.at e.to_i
      dformat t.utc
    end
    def epochtime(e)
      t = Time.at e.to_i
      tformat t.utc
    end
    def epochformat(e)
      t = Time.at e.to_i
      dtformat t.utc
    end
    def epochformat2(e)
      t = Time.at e.to_i
      dtformat2 t.utc
    end
    def epochdom(e)
      t = Time.at e.to_i
      t.utc.strftime('%b %d')
    end
    def epochtod(e)
      t = Time.at e.to_i
      t.utc.strftime('%I:%M%p').gsub(/^0/, '').downcase
    end
    def epochcsvformat(e)
      t = Time.at e.to_i
      t.utc.strftime("%Y/%m/%d %H:%M:%S")
    end
    def dtformat(t)
      t = DateTime.parse t unless t.kind_of?(Time)
      t.strftime("%Y-%m-%d@%H:%M:%S UTC")
    end
    def dtformat2(t)
      t = DateTime.parse t unless t.kind_of?(Time)
      t.strftime("%Y-%m-%d@%H:%M UTC")
    end
    def dformat(t)
      t = DateTime.parse t unless t.kind_of?(Time)
      t.strftime("%Y-%m-%d")
    end
    def tformat(t)
      t = DateTime.parse t unless t.kind_of?(Time)
      t.strftime("%H:%M:%S")
    end
  end

end
