class Stella::App::Machine
  include Stella::App::Base

  def delete
    authenticated('/account/machines') do
      enforce_method! :POST
      logic = Stella::Logic::DeleteMachine.new sess, cust, req.params
      logic.raise_concerns
      logic.process
      #sess.add_info_message! "Machine deleted."
      res.redirect '/account/machines' unless req.ajax?
    end
  end

  # Remove stale workers
  def tidyup
    authenticated('/account/machines') do
      enforce_method! :POST
      logic = Stella::Logic::TidyupMachine.new sess, cust, req.params
      logic.raise_concerns
      logic.process
      sess.add_info_message! "Machine updated."
      res.redirect '/account/machines' unless req.ajax?
    end
  end

end


module Stella::App::Views

  module Machine
    class Index < Stella::App::View
      attr_accessor :tab
      def init *args
        @title = "Your Machines"
      end
    end

  end
end
