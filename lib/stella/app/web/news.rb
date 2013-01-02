

class Stella
  class App
    class News
      include Base
      
      def index
        publically do
          view = Stella::App::Views::News.new req, sess, cust
          res.body = view.render
        end
      end

      def delete
        privately '/news' do
          post!
          employees!
          assert_params :convoid
          expanded_id = Convo.expand req.params[:convoid].strip
          convo = Convo.from_redis expanded_id
          convo.destroy! :messages => true
          VendorInfo.global.convos.remove convo
          res.redirect uri_path('news', 'update')
        end
      end

      def publish
        privately '/news' do
          post!
          employees!
          assert_params :convoid
          expanded_id = Convo.expand req.params[:convoid].strip
          convo = Convo.from_redis expanded_id
          if req.params[:homepage] == 'true'
            convo.homepage = true 
            convo.save
          end
          if convo.draft?
            # only run the PublishConvo job when the item is published for the first time
            BS::Job::PublishConvo.enqueue :convoid => convo.id 
          else
            # otherwise we can just call publish! ourselves (moved unread messages to read)
            convo.publish!
          end
          res.redirect uri_path('news', convo.id)
        end
      end

      def create
        privately '/news' do
          employees!
          if req.post?
            assert_params :u, :c
            convo = Convo.new cust.custid
            convo.add_msg req.params[:u], :tucker, req.params[:c]
            convo.save
            res.redirect uri_path('news', 'update', convo.id)
          else
            view = Stella::App::Views::NewsUpdate.new req, sess, cust
            res.body = view.render
          end
        end
      end

      def update
        privately '/news' do
          employees!
          assert_params :convoid
          expanded_id = Convo.expand req.params[:convoid].strip
          convo = Convo.from_redis expanded_id
          if req.post?
            assert_params :u, :c
            convo.add_msg req.params[:u], :tucker, req.params[:c]
            convo.save
            res.redirect ['', 'news', 'update', convo.id].join('/')
          else
            view = Stella::App::Views::NewsUpdate.new req, sess, cust, convo
            res.body = view.render
          end
        end
      end

    end
  end
end

module Stella::App::Views
  
  class NewsUpdate < Stella::App::View
    def init convo=nil
      self[:convo] = convo
      self[:convoid] = convo.id if convo
      @title = "Add News"
      @body_class = 'news'
      @feed_uri = "#{baseuri}/news.atom"
      @css << '/app/style/component/news.css'
      @jsvars << jsvar(:convoid, self[:convoid])
    end
    # partial/convo expects an Array of convo objects (should only be one here)
    def convos
      if self[:convo]
        payload = self[:convo].to_hash
        payload[:convo_messages] = self[:convo].unsent_messages.members.collect { |msg| 
          msg.sensitive!
          #msg.content = msg.content.to_s.linkify
          msg
        }
        [payload]
      else
        ret = VendorInfo.global.convos.revmembers.collect do |convo|
          payload = convo.to_hash
          payload[:convo_messages] = convo.sent_messages.members.collect { |msg| 
            msg.sensitive!
            #msg.content = msg.content.to_s.linkify
            msg
          }
          payload[:convoid] = convo.id
          payload[:news_date] = newsdate(convo.updated)
          payload
        end
        ret
      end
    end
  end

  class News < Stella::App::View
    attr_reader :feed_uri
    def init *args
      @title = "News - Conversations with Morton and Tucker"
      @body_class = 'news'
      @feed_uri = "#{baseuri}/news.atom"
      @css << '/app/style/component/news.css'
      @jsvars << jsvar(:convoid, params[:convoid])
      @quarter = params[:q]
      @quarter ||= '1898Q3'
      @quarter.gsub! /\W/, ''
    end
    def quarterly
      self.class.quarterly @quarter
    end
    def self.quarterly quarter
      @cache ||= {}
      @cache[quarter] ||= File.read("./templates/quarterlies/#{quarter}.mustache")
      @cache[quarter]
    end
    # <%= partial(:'_partials/convo', :convo => convo, :style=>"", :show_date => 'heading') %>
  end
end