require 'stella/logic'

module Stella::Logic

  #class ViewCheckup < Stella::Logic::Base
  #end

  class MetricsCollector < Stella::Logic::Base
    attr_reader :mc, :format, :content, :jsonp
    attr_reader :duration, :epoint, :d, :e
    def raise_concerns
      check_rate_limits! :public_data_get
    end

    def format?(guess)
      guess.to_s == @format.to_s
    end

    protected

    def process_params
      params[:format] ||= 'html'
      @content = params[:content].to_s.gsub(/\W/, '').to_sym if params[:content]
      @jsonp = params[:jsonp].gsub /(?!\.\w)\W/, '' if params[:jsonp]
      @jsonp = params[:callback].gsub /(?!\.\w)\W/, '' if params[:callback]
      @format = params[:format] if Stella::Logic.valid_format?(params[:format])
      if !params[:planid].to_s.empty?
        @mcid = params[:planid].to_s.strip
        @mcid = Stella::Testplan.expand @mcid
        #@mcklass = MonitorInfo
        @mckind = "plan"
      elsif !params[:hostid].to_s.empty?
        @mcid = params[:hostid].to_s.strip
        #@mcklass = HostInfo
        @mckind = "host"
      elsif !params[:vendorid].to_s.empty?
        @mcid = params[:vendorid].to_s.strip
        #@mcklass = VendorInfo
        @mckind = "vendor"
      end
      if ['enabled', 'disabled', 'monitored'].member?(params[:mode] || '')
        @mode = params[:mode]
      end
      @duration = params[:d].to_i if params[:d].to_i > 0
      @epoint = params[:e].to_i if params[:e].to_i > 0
    end

  end
end
