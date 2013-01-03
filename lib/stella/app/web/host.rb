

class Stella::App::Host
  include Stella::App::Base
  attr_reader :host


  def host
    @host ||= if req.params[:hostid]
      Stella::Host.first :hostid => req.params[:hostid]
    elsif req.params[:hostname]
      Stella::Host.first( :hostname => req.params[:hostname], :custid => cust.custid) ||
      Stella::Host.first( :hostid => req.params[:hostname])
    end
    @host
  end

  def is_owner?
    host && (cust.colonel? || host.customer?(cust))
  end

  def add_contact
    authenticated do
      enforce_method! :POST
      if is_owner?
        p [req.params]
      else
        not_found_response "No such host"
      end
    end
  end

  def destroy
    authenticated do
      enforce_method! :POST
      if is_owner?
        host.destroy!
        sess.add_info_message! "Destroyed #{host.hostname}"
        # TODO: Also stop monitoring.
        res.body = json(:status => :success)
      else
        not_found_response "No such host"
      end
    end
  end

  def hide
    authenticated do
      enforce_method! :POST
      if is_owner?
        host.hidden = true
        host.stop!
        sess.add_info_message! "Removed #{host.hostname}"
        # TODO: Also stop monitoring.
        res.body = json(:status => :success)
      else
        not_found_response "No such host"
      end
    end
  end

  def screenshot
    authenticated do
      enforce_method! :POST
      if is_owner?
        #plan = Stella::Testplan.first_or_create :uri => uri.to_s, :custid => cust.custid, :host => host, :hostid => host.hostid
        #Stella::Job::RenderPlan.enqueue :planid => plan.planid
        Stella::Job::RenderHost.enqueue :hostid => host.hostid
        sess.add_info_message! "Updating screenshot for #{host.hostname}"
        res.body = json(:status => :success)
      else
        not_found_response "No such host"
      end
    end
  end

  def notify
    authenticated do
      enforce_method! :POST
      if is_owner?
        host.notify = (req.params[:mode] == 'enable')
        host.save
        sess.add_info_message! "Notifications are now #{req.params[:mode]}d."
        res.redirect "/site/#{host.hostname}" unless req.ajax?
      else
        not_found_response "No such host"
      end
    end
  end

  def settings
    authenticated do
      enforce_method! :POST
      if is_owner?
        host.settings['disable_ga'] = (req.params[:disable_ga] == 'true')
        host.settings['gaid'] = req.params[:gaid]
        seconds = req.params["interval"].to_i
        if seconds > 0 && seconds >= host.product.options["interval"].to_i
          host.settings['interval'] = seconds
        end
        host.save
        sess.add_info_message! "Settings saved for #{host.hostname}."
        res.redirect "/site/#{host.hostname}" unless req.ajax?
      else
        not_found_response "No such host"
      end
    end
  end

  def show
    authenticated do
      enforce_method! :POST
      if is_owner?
        host.hidden = false
        host.save
        sess.add_info_message! "Added #{host.hostname}"
        res.redirect '/'
      else
        not_found_response "No such host"
      end
    end
  end

  def upgrade
    start
  end

  def start
    authenticated do
      enforce_method! :POST
      if is_owner?
        host.start! :site_basic_v1
        sess.add_info_message! "Started monitoring #{host.hostname}"
        res.redirect '/' unless req.ajax?
      else
        not_found_response "No such host"
      end
    end
  end

  def stop
    authenticated do
      enforce_method! :POST
      if is_owner?
        host.stop!
        if Stella::Logic.safedb { host.save }
          sess.add_info_message! "Stopped monitoring #{host.hostname}"
        else
          sess.add_error_message! "Cannot update host. Please try again later."
        end
        res.redirect '/' unless req.ajax?
      else
        not_found_response "No such host"
      end
    end
  end

  def index
    publically do
      if is_owner? || (host && host.custid == Stella::Customer.anonymous.custid)
        view = Stella::App::Views::Host.new req, sess, cust, host
        res.body = view.render
      else
        not_found_response "No such host"
      end
    end
  end

  def plan
    publically do
      plan = Stella::Testplan.first :planid => req.params[:planid]
      @host = plan.host if plan
      if is_owner? || (host && host.custid == Stella::Customer.anonymous.custid)
        view = Stella::App::Views::Plan.new req, sess, cust, plan
        res.body = view.render
      else
        not_found_response "No such plan"
      end
    end
  end

  def testrun
    publically do
      testrun = Stella::Testrun.first :runid => req.params[:runid]
      @plan = testrun.testplan if testrun
      @host = @plan.host if @plan
      if is_owner? || host.custid == Stella::Customer.anonymous.custid
        view = Stella::App::Views::Testrun.new req, sess, cust, testrun
        res.body = view.render
      else
        not_found_response "No such testrun"
      end
    end
  end

  def hide_plan
    authenticated do
      enforce_method! :POST
      plan = Stella::Testplan.first :planid => req.params[:planid]
      @host = plan.host if plan
      if is_owner?
        plan.enabled = false
        plan.hidden = true
        if host.monitored && host.testplans(:hidden => false, :enabled => true).size == 0
          host.monitored = false
          host.save
        end
        plan.save
        res.redirect '/' unless req.ajax?
      else
        not_found_response "No such plan"
      end
    end
  end

  def enable_plan
    authenticated do
      enforce_method! :POST
      plan = Stella::Testplan.first :planid => req.params[:planid]
      @host = plan.host if plan
      if is_owner?
        plan.enabled = true
        plan.hidden = false
        plan.save
        host.start!
        sess.add_info_message! "Enable monitoring for #{plan.parsed_uri}"
        res.redirect '/' unless req.ajax?
      else
        not_found_response "No such plan"
      end
    end
  end

  def disable_plan
    authenticated do
      enforce_method! :POST
      plan = Stella::Testplan.first :planid => req.params[:planid]
      @host = plan.host if plan
      if is_owner?
        plan.enabled = false
        plan.save
        if host.monitored && host.testplans(:hidden => false, :enabled => true).size == 0
          host.stop!
          sess.add_info_message! "Stopped monitoring #{plan.host.hostname}!"
        end
        sess.add_info_message! "Disabled monitoring for #{plan.parsed_uri}"
        res.redirect '/' unless req.ajax?
      else
        not_found_response "No such plan"
      end
    end
  end

end

module Stella::App::Views

  class Host < Stella::App::View
    def init host
      @title = host.hostname
      @css << '/app/style/component/host.css'
      @body_class = :host
      self[:host] = host
      self[:owner_only] = self[:authenticated] && (host.customer?(cust) || cust.colonel?)
      self[:testplans] = host.testplans :hidden => false, :order => [ :enabled.desc, :uri ]
      #self[:summary] = self[:testruns].first.summary if self[:testruns]
      self[:ran_at] = self[:host].updated_at
      self[:ran_at_js] = self[:ran_at].to_i * 1000
      self[:ran_at_text] = epochformat(self[:ran_at])
      self[:ran_at_natural] = natural_time(self[:ran_at].to_i)
      self[:incident_count] = 0
      self[:selected_tabid] = req.params[:tabid]
      self[:pages_count] = self[:testplans].size
      self[:enabled_pages] = self[:testplans].select { |page| page.enabled }
      self[:enabled_pages_count] = self[:enabled_pages].size
      self[:has_enabled_pages] = ! self[:enabled_pages_count].zero?
      self[:has_pages] = ! self[:pages_count].zero?
      unless host.product
        host.update_product :site_free_v1
      end
      self[:max_enabled_pages] = host.product.options['pages'].to_i
      self[:has_max_pages] = self[:enabled_pages_count] >= self[:max_enabled_pages]
      self[:is_free_plan] = host.product.free?
      self[:is_paid_plan] = host.product.paid?
      self[:is_basic_plan] = host.product.price < 10.0
      case host.settings['interval']
      when 5.minutes then self[:checked_5m], self[:checked_interval] = true, "5 minutes"
      when 30.minutes then self[:checked_30m], self[:checked_interval] = true, "30 minutes"
      when 60.minutes then self[:checked_60m], self[:checked_interval] = true, "60 minutes"
      when 24.hours then self[:checked_24h], self[:checked_interval] = true, "24 hours"
      end
    end
  end

  class Plan < Stella::App::View
    def init plan
      @title = plan.uri
      @css << '/app/style/component/host.css'
      @body_class = :host
      self[:plan] = plan
      self[:host] = plan.host
      self[:testruns] = plan.recent_testruns
      if self[:testruns].first
        self[:summary] = self[:testruns].first.summary
        self[:ran_at] = self[:testruns].first.created_at.utc
        self[:ran_at_js] = self[:ran_at].to_i * 1000
        self[:ran_at_text] = epochformat(self[:ran_at])
        self[:ran_at_natural] = natural_time(self[:ran_at].to_i)
      end
    end
  end

  class Testrun < Stella::App::View
    def init testrun
      @title = testrun.testplan.uri
      @css << '/app/style/component/checkup.css'
      @body_class = :checkup
      self[:testrun] = testrun
      self[:testplan] = testrun.testplan
      self[:host] = testrun.testplan.host
      self[:this_uri] = self[:testplan].requests.first
      self[:this_path] = self[:this_uri].path
      self[:this_shortpath] = File.basename(self[:this_path]).shorten(30)
      self[:this_host_uri] = '%s://%s' % [self[:this_uri].scheme, self[:this_uri].host]
      self[:summary] = testrun.summary
      self[:is_done] = self[:testrun].status?(:done, :fubar, :cancelled)
      self[:is_fubar] = self[:testrun].status?(:fubar) || self[:testrun].status?(:error)
      self[:is_running] = self[:testrun].status?(:running, :pending, :new)

      if self[:summary]
        self[:ran_at] =testrun.created_at.utc
        self[:ran_at_js] = self[:ran_at].to_i * 1000
        self[:ran_at_text] = epochformat(self[:ran_at])
        self[:ran_at_natural] = natural_time(self[:ran_at].to_i)
      end
    end
  end


end
