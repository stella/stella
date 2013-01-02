

class Stella
  class App
    class Colonel
      module Views
      end
      class View < Stella::App::View
        #require 'stella/app/colonel/views/helpers'
        self.template_path = './templates/colonel'
        self.view_namespace = Stella::App::Colonel::Views

        def colonel_vars
          @body_class = 'colonel'
          @css << '/app/style/component/colonel.css'
          self[:colonel_nav] = [
            { :path => :customers, :name => 'Customers' }
          ]
          self[:stella_version] = Stella::VERSION
        end

      end
    end
  end
end
