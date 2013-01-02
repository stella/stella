class Stella
  class App
    class Checkup
      include Base

      def status
        publically do
          logic = Stella::Logic::ViewCheckup.new sess, cust, req.params
          logic.raise_concerns
          res.body = json(:status => logic.checkup.status)
        end
      end

      def get
        publically do
          logic = Stella::Logic::ViewCheckup.new sess, cust, req.params
          begin
            logic.raise_concerns
            view = Stella::App::Views::Checkup.new req, sess, cust, logic.checkup
            res.body = view.render
          rescue Stella::NoRun => ex
            view = Stella::App::Views::CheckupMissing.new req, sess, cust, logic.checkup
            res.status = 404
            res.body = view.render
          end
        end
      end

      def run
        publically('/') do
          logic = Stella::Logic::CreateCheckup.new(sess, cust, req.params)
          logic.raise_concerns(:create_checkup)
          logic.create
          logic.queue_jobs
          res.redirect '/checkup/%s' % [logic.checkup.checkid]
        end
      end

      def signup_express
        publically(req.path) do
          if req.post?
            #assert_params :email, :password
            logic = Stella::Logic::Signup.new(sess, cust, req.params)
            logic.raise_concerns
            logic.process
            # We need to overwrite the existing session and customer
            @sess, @cust = logic.sess, logic.cust
            res.redirect '/'
          end
        end
      end
    end
  end
end


module Stella::App::Views
  class Checkup < Stella::App::View
    def init checkup, uri=nil
      @js << '/etc/jquery/jquery-ui.min.js'
      @js << '/app/component/checkup.js'
      @css << '/app/style/component/checkup.css'
      self[:checkup], self[:testplan] = checkup, checkup.testplan
      self[:owner], self[:host] = self[:checkup].customer, self[:checkup].host
      self[:this_uri] = self[:testplan].requests.first
      self[:this_path] = self[:this_uri].path
      self[:this_shortpath] = File.basename(self[:this_path]).shorten(30)
      self[:this_host_uri] = '%s://%s' % [self[:this_uri].scheme, self[:this_uri].host]
      self[:is_done] = self[:checkup].status?(:done, :fubar, :cancelled)
      self[:is_fubar] = self[:checkup].status?(:fubar) || checkup.status?(:error)
      self[:is_running] = self[:checkup].status?(:running, :pending, :new)
      self[:is_owner] = self[:checkup].customer?(cust)
      self[:is_homepage] = self[:this_path] == '/'
      self[:hide_feedback_form] = !self[:is_running]
      self[:ran_at] = self[:checkup].updated_at
      self[:ran_at_js] = self[:ran_at].to_i * 1000
      self[:ran_at_text] = epochformat(self[:ran_at])
      self[:ran_at_natural] = natural_time(self[:ran_at].to_i)
      self[:host_at_natural] = natural_time(self[:host].updated_at.to_i)
      @title = "Status of #{self['this_uri']} on #{self['ran_at_text']}"
      @body_class = "checkup"
      self[:summary] = checkup.summary
    end

  end
  class CheckupMini < Stella::App::View
    def init *args
      @title = "Run checkup for #{params[:uri]}"
    end
  end
  class CheckupMissing < Stella::App::View
    attr_accessor :checkup
    attr_reader :show_plan_message, :show_generic_message
    def init checkup=nil
      self[:checkup] = checkup
      @title = "Expired Checkup"
      #@show_plan_message = checkup && checkup.testplan.customer.free?
      @show_generic_message = !cust.paying? && !show_plan_message
      @css << '/app/style/component/checkup.css'
    end
  end
end

__END__
module Views

  class Checkup < Site2::View
    attr_accessor :testrun, :testplan, :uri
    attr_reader :metrics, :host, :owner
    def init testrun, testplan, uri=nil
      @testrun, @testplan = testrun, testplan
      @host = testrun.host
      @owner = testrun.cust
      jsvars << jsvar(:runid, testrun.runid) if testrun
      self['this_uri'] = testplan ? testplan.first_request.uri : (uri || 'http://stellaaahhhh.com')
      if testplan
        jsvars << jsvar(:planid, testplan.planid)
      end
      self['is_done'] = testrun.status?(:done) || testrun.failed? || testrun.cancelled?
      self['is_fubar'] = testrun.fubar?
      self['is_running'] = testrun.running? || testrun.pending? || testrun.new?
      self['has_errors'] = testrun.errors?
      self['show_authost'] = false #testrun.status?(:done)
      self['is_authost'] = host.owner?(cust)
      self['is_owner'] = owner.custid == cust.custid
      self['has_report'] = testrun.status?(:done) && testrun.report
      self['has_vendors'] = !vendors.empty?
      self['hosttext'] = host.hostid.to_s.shorten(18)
      self['ran_at'] = testrun.end_time || testrun.start_time
      if !testplan.usecases.empty?
        http_auth = testplan.usecases.first.http_auth || {}
        self['this_http_auth_user'] = http_auth[:user] || http_auth['user']
        self['this_http_auth_pass'] = http_auth[:pass] || http_auth['pass']
      end
      if self['is_done']
        @metrics = testrun.report.metrics
        self['ran_at_js'] = self['ran_at'] * 1000
        self['ran_at_text'] = epochformat(self['ran_at'])
        self['page_size'] = metrics.response_content_size.mean.to_bytes
        self['has_headers'] = !testrun.report.headers.empty?
        self['has_content'] = !testrun.report.content.response_body.to_s.empty?
        self['has_cname'] = !host.cname.size.zero?
        self['cname'] = host.cname.members if self['has_cname']
        self['has_ipaddr'] = !host.ipaddr.size.zero?
        if self['has_ipaddr']
          self['ipaddresses'] = host.ipaddr.members.collect { |ipaddr|
            payload = ipaddr.to_hash
            payload[:whois] = ipaddr.whois.value.to_hash
            payload[:whois][:updated_at] = natural_time(payload[:whois][:updated])
            payload
          }
        end
        self['has_dns'] = self['has_cname'] || self['has_ipaddr']
        self['has_whois'] = host.whois? && host.whois.value.content
        self['has_previous_checkups'] = testplan && testplan.checkups.size >= 1
        self['auth_required'] = testrun.report.auth_required?
        self['request_headers'] = testrun.report.headers.request_headers
        self['response_headers'] = testrun.report.headers.response_headers
        self['response_content'] = colorize(testrun.report.content.response_body, testrun.report.headers.response_headers)
        if self['has_whois']
          self['whois'] = host.whois.value.to_hash
          self['whois']['register_date'] = host.whois.register_date
          self['whois']['register_date_text'] = epochformat(host.whois.register_date)
          self['whois']['update_date'] = host.whois.update_date
          self['whois']['update_date_text'] = epochformat(host.whois.update_date)
          self['whois']['expires_in'] = host.whois.expires_in.in_days.to_i if host.whois.expires_in
          self['whois']['updated_at_text'] = natural_time(self['whois'][:updated])
          self['whois'][:content] = obscure_email(self['whois'][:content].encode_fix("US-ASCII"))
        end
      end
      @js << '/etc/jquery/jquery-ui.min.js'
      @js << '/app/component/checkup.js'
      @css << '/app/style/component/checkup.css'
      @css << '/etc/highlight/colourize.css'
      @title = "Status of #{self['this_uri']} on #{self['ran_at']}"
    end

    def colorize(content, type)
      type ||= ''
      if type.match(/html/)
        CodeRay.scan(content, :html).html
      elsif type.match(/json/)
        CodeRay.scan(content, :json).html
      elsif type.match(/yaml/)
        CodeRay.scan(content, :yaml).html
      elsif type.match(/xml/)
        CodeRay.scan(content, :xml).html
      elsif type.match(/text\/plain/)
        content
      end
    end

    def error_messages
      if @error_messages.nil?
        seen = []
        @error_messages = testrun.report.errors.all.collect do |err|
          next if seen.member?(err['msg'])
          seen << err['msg']
          err['msg']
        end.compact
      end
      @error_messages
    end

    def vendors
      @vendors ||= host.vendors.membersraw.collect { |vendor|
        {:vendoruri => "/vendor/#{vendor}", :name => vendor, :last => false}
      }
      @vendors.last[:last] = true unless @vendors.empty?
      @vendors
    end

    def score
      @score ||= MetricScores.new(metrics.response_time.mean, metrics.socket_connect.mean,
                                  metrics.send_request.mean, metrics.first_byte.mean, metrics.last_byte.mean)
      @score
    end

    def rating
      @rating ||= if self['has_errors']
        "Has errors"
      elsif score.fastest?
       "The best!"
      elsif score.fast?
        "Lovin' it!"
      elsif score.alright?
        "Fine job."
      elsif score.slow?
        "Not great"
      elsif score.slowest?
        "Needs work."
      else
        "The worst!"
      end
      @rating
    end

    def rating_class
      'fail' if score.slow? || score.slowest? || score.scary? || self['has_errors']
    end

    def breakdowns
      if @breakdowns.nil?
        @breakdowns = []
        if self['has_previous_checkups']
          @breakdowns = testplan.checkups.revmembers(5).collect do |run|
            next if !run.done? || run.id == testrun.id
            create_breakdown run
          end
          @breakdowns.compact!
        end
        @breakdowns.unshift create_breakdown(testrun, :current) if self['is_done']
        @breakdowns.push global_breakdown
      end
      @breakdowns
    end

    def summary
      if @summary.nil?
        tmp = if testrun.errors?
          [ :slow, 'Error!', "The page you tried isn't responding properly.", "Details below."]
        elsif testrun.report.redirect?
          advice2 = if redirect_uri.nil?
            " Bad redirect: #{ h(testrun.report.headers.response_header(:Location).to_s) }"
          else
            %Q{Try this: <a href="/checkup?uri=#{ h(redirect_uri.to_s)}" class="checkupRedirectTry">#{ redirect_uri }</a>}
          end
          [:slowish, "That's a redirect.", "Are you sure that's what you want to test?", advice2]
        elsif score.fastest?
          [:fast, 'Great!', 'The page is <em class="fast">much faster</em> than most sites.']
        elsif score.fast?
          [:fast, 'Quite fast.', 'The page is faster than most sites.']
        elsif score.alright?
          [:slowish, 'Not bad.', "It's on par with most sites."]
        elsif score.slow?
          [:slowish, 'Not so fast.', 'The page was slower than most sites.']
        elsif score.slowest?
          [:slow, 'Hmm.', 'The page was <em class="slow">much slower</em> than most sites.']
        elsif score.timeout?
          [:slow, 'Timeout.', 'Something is under duress.']
        else
          [:slow, 'The slowest.', 'Something is under duress.']
        end
        @summary = Hash[[:css, :yay, :advice1, :advice2].zip(tmp)]
        if score.timeout?
          @summary[:advice2] = if score.sc_rating == :nominal
            "Connection time is fine, so it looks like an #{ score.slowest_part == :fb ? 'app' : 'network' } problem."
          elsif score.fb_rating == :nominal
            if @score.slowest_part == :sc
              "Connection time is the problem. Check your front-end server or load balancer, etc."
            else
              "Download time is the problem. Check the network and bandwidth limits. "
            end
          elsif score.lb_rating == :nominal
            "Your servers are probably overloaded."
          else
            "Everything took a long time."
          end
        elsif @score.sc_rating != :nominal
          @summary[:advice2] = (@score.fastish? || @score.alright?) ? 'But it' : 'It'
          @summary[:advice2] << " took longer than usual to connect. Details below."
        elsif @score.fb_rating != :nominal
          @summary[:advice2] = (@score.fastish? || @score.alright?) ? 'But the' : 'The'
          @summary[:advice2] << " server took a long time to generate the content. Details below."
        elsif @score.lb_rating != :nominal
          @summary[:advice2] = (@score.fastish? || @score.alright?) ? 'But the' : 'The'
          @summary[:advice2] << " server took a long time to deliver it. Details below."
        end
      end
      @summary
    end

    def cta_button
      if @cta_button.nil?
        @cta_button = if testplan.monitored?
          { :uri => "/plan/#{testplan.planid}/report", :text => "This Page Is Monitored" }
        elsif cust.anonymous? # TODO: associate testrun to session
          { :uri => '/signup', :text => "Start monitoring for free<em>!</em>" }
          #<div style="padding-top: 4px; text-align: center; font-style: italic"><a href="#" class="hiddenHelpLink">More info</a></div>
          #<%= partial(:'_partials/monitorhelp')
        elsif testrun.custid == cust.custid && !testrun.errors?
          remaining = cust.monitors.remaining
          if remaining <= 0
            next_plan = cust.product.next
            tmp = if next_plan
              { :uri => '/signup', :text => "Upgrade to the #{next_plan.name} plan" }
            else
              { :text => "<strong>Your #{cust.product.name} account is maxed out!</strong>"}
            end
            tmp[:subtext] ="You have #{cust_enabled_monitors} of #{cust_max_monitors} monitors enabled!"
            tmp
          else
            false
          end
        end
      end
      @cta_button
    end

    def auth
      @auth ||= host.auth
      if @auth.nil?
        # This is used to generate the potential secret to display
        # to the customer. Note that we don't save it. Just for show.
        @auth = HostInfo::Auth.new host.hostid, cust.custid
        @auth.update_secret cust.entropy
      end
      @auth
    end

    def authost_failed
      host.owner?(cust, :any) && host.auth.status?(:verified)
    end

    def authost_available
      !auth.exists? && !cust.anonymous? && cust.paying? && cust.authorized_hosts.remaining?
    end

    def authost_upgrade
      !cust.anonymous? && (cust.free? || !cust.authorized_hosts.remaining?)
    end

    # only display the monitor button
    def monitor_button
      cta_button == false && (testplan.monitor.nil? || !testplan.monitor.enabled)
    end

    private
    def create_breakdown run, current=false
      metric_scores = MetricScores.new(
        run.report.metrics.response_time.mean,
        run.report.metrics.socket_connect.mean,
        run.report.metrics.send_request.mean,
        run.report.metrics.first_byte.mean,
        run.report.metrics.last_byte.mean
      )
      {
        :natural_time => "tested #{natural_time(run.end_time)}",
        :epoch_time => (run.end_time||0)*1000,
        :metrics_scores => metric_scores,
        :response_time => pretty_ms(run.report.metrics.response_time.mean.to_ms),
        :socket_connect => pretty_ms(run.report.metrics.socket_connect.mean.to_ms),
        :send_request => pretty_ms(run.report.metrics.send_request.mean.to_ms),
        :first_byte => pretty_ms(run.report.metrics.first_byte.mean.to_ms),
        :last_byte => pretty_ms(run.report.metrics.last_byte.mean.to_ms),
        :uid => '',
        :extra_class => current ? '' : 'history',
        :uri => "/checkup/#{run.runid}",
        :with_labels => current,
        :sc_score => metric_scores.sc_score,
        :fb_score => metric_scores.fb_score,
        :lb_score => metric_scores.lb_score,
        :sc_rating => metric_scores.sc_rating,
        :fb_rating => metric_scores.fb_rating,
        :lb_rating => metric_scores.lb_rating
      }
    end
    def global_breakdown
      metric_scores = MetricScores.new(
        MetricScores.global.rt,
        MetricScores.global.sc,
        MetricScores.global.sr,
        MetricScores.global.fb,
        MetricScores.global.lb
      )
      {
        :natural_time => "Average of all sites tested today",
        :epoch_time => 0,
        :metric_scores => metric_scores,
        :response_time => pretty_ms(MetricScores.global.rt.to_ms),
        :socket_connect => pretty_ms(MetricScores.global.sc.to_ms),
        :send_request => pretty_ms(MetricScores.global.sr.to_ms),
        :first_byte => pretty_ms(MetricScores.global.fb.to_ms),
        :last_byte => pretty_ms(MetricScores.global.lb.to_ms),
        :uid => 'averages',
        :extra_class => '',
        :uri => '/report',
        :with_labels => false,
        :sc_score => metric_scores.sc_score,
        :fb_score => metric_scores.fb_score,
        :lb_score => metric_scores.lb_score,
        :sc_rating => metric_scores.sc_rating,
        :fb_rating => metric_scores.fb_rating,
        :lb_rating => metric_scores.lb_rating
      }
    end
    def redirect_uri
      if @redirect_uri.nil?
        tmp = Addressable::URI.parse self['this_uri']
        location = testrun.report.headers.response_header(:Location)
        location = "/#{location}" unless location.match(/\A(\/|http)/)
        uri = Addressable::URI.parse location
        uri.scheme ||= tmp.scheme
        uri.host ||= tmp.host
        uri.port ||= tmp.port
        @redirect_uri = uri
      end
      @redirect_uri
    rescue Addressable::URI::InvalidURIError
      uri = nil
    end
  end

end
