
class Stella::App::Info
  include Stella::App::Base
  
  def company
    publically do
      view = Stella::App::Views::Info::Company.new req, sess, cust
      res.body = view.render
    end
  end
  
  def privacy
    publically do
      view = Stella::App::Views::Info::Privacy.new req, sess, cust
      res.body = view.render
    end
  end
  
  def terms
    publically do
      view = Stella::App::Views::Info::Terms.new req, sess, cust
      res.body = view.render
    end
  end
  
  def refund
    publically do
      view = Stella::App::Views::Info::Refund.new req, sess, cust
      res.body = view.render
    end
  end
  
  def about
    res.redirect '/info/company'
  end
  
end

module Stella::App::Views
  
  class Info < Stella::App::View
    
    class Company < Info
      def init *args
        @title = "About"
        @css << '/app/style/component/about.css'
        @css << '/app/style/component/news.css'
        self[:hello_style] = :mustache_hello
      end
    end

    class Privacy < Info
      def init *args
        @title = "Privacy Policy"
      end
    end
    
    class Terms < Info
      def init *args
        @title = "About"
      end
    end
    
    class Refund < Info
      def init *args
        @title = "Refund Policy"
      end
    end
    

    class Bookmarklet < Stella::App::View
      def init *args
        @title = "Bookmarklet"
      end
    end
  end
  
end