require 'httparty'

class Stella
  # export STELLA_CUSTID=email
  # export STELLA_APIKEY=apikey
  # export STELLA_REMOTE=http://127.0.0.1:3000/
  class API
    include HTTParty
    #ssl_ca_file Stella::Client::SSL_CERT_PATH
    #debug_output $stdout
    base_uri 'https://www.blamestella.com/'
    format :json
    attr_reader :opts, :response, :custid, :key, :default_params
    attr_accessor :apiversion
    def initialize custid=nil, key=nil, opts={}
      @opts = opts
      @custid = custid || ENV['STELLA_CUSTID']
      @key = key || ENV['STELLA_APIKEY']
      @apiversion = opts.delete(:apiversion) || opts.delete('apiversion') || 3
      base_uri = opts.delete(:stella_remote) || opts.delete('stella_remote') || ENV['STELLA_REMOTE']
      self.class.base_uri(base_uri) if !base_uri.to_s.empty?
      @default_params = {}
      unless @custid.to_s.empty? || @key.to_s.empty?
        opts[:basic_auth] ||= { :username => @custid, :password => @key }
      end
    end
    def get path, params=nil
      opts = self.opts.clone
      opts[:query] = (params || {}).merge default_params
      execute_request :get, path, opts
    end
    def post path, params=nil
      opts = self.opts.clone
      opts[:body] = (params || {}).merge default_params
      execute_request :post, path, opts
    end
    def base_uri path
      uri = Addressable::URI.parse self.class.base_uri
      uri.path = path(path)
      uri.to_s
    end
    def path *args
      args.unshift ["/api/v#{apiversion}"] # force leading slash and version
      path = args.flatten.join('/')
      path.gsub '//', '/'
    end
    private
    def execute_request meth, path, opts
      path = self.path(path)
      @response = self.class.send meth, path, opts
      Stella::Utils.indifferent_params @response.parsed_response
    rescue MultiJson::DecodeError => ex
      raise RuntimeError, "Bad response: #{@response.body}"
    end
    class << self
    end
  end
end
