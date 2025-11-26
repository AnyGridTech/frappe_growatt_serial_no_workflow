// Copyright (c) 2025, AnyGridTech and contributors
// For license information, please see license.txt
"use strict";
(() => {
  // doctype/serial_no_workflow/ts/main.ts
  var is_force_state_allowed = false;
  var allowedRoles = ["Information Technology User", "Administrator", "System Manager"];
  var OUTPUT_INFO_MESSAGE = {
    SN_NOT_FOUND: "SN n\xE3o encontrado.",
    SN_FOUND_ERP: "SN encontrado na base do ERPNext.",
    SN_FOUND_GROWATT: "SN encontrado na base da Growatt.",
    SN_INVALID: "N\xFAmero de s\xE9rie inv\xE1lido.",
    SN_DUPLICATED: "N\xFAmero de s\xE9rie duplicado.",
    INPUT_VALIDATION_ERROR: "Erro ao validar entrada.",
    INVALID_WORKFLOW_TRANSITION: "Transi\xE7\xE3o de workflow state inv\xE1lida."
  };
  frappe.ui.form.on("Serial No Workflow", {
    refresh: async function(form) {
      form.set_df_property("next_step", "options", []);
      const sn_workflow = await frappe.call({
        method: "frappe.desk.form.load.getdoc",
        // Método padrão do Frappe para carregar um documento.
        args: {
          doctype: "Workflow",
          // Carrega o Doctype Workflow.
          name: "workflow_serial_no"
          // Carrega o Workflow específico chamado 'workflow_serial_no'.
        }
      }).catch((e) => console.error(e)).then((r) => r && Array.isArray(r.docs) && r.docs.length > 0 ? r.docs[0] : void 0);
      if (!sn_workflow) return frappe.throw("Workflow not found.");
      const workflow_transitions = sn_workflow.transitions;
      const user_roles = frappe.boot.user.roles;
      const next_step_options = [];
      const allowed_workflow_transitions = workflow_transitions.filter((t) => user_roles.includes(t.allowed));
      outterLoop:
        for (let allowed_transition of allowed_workflow_transitions) {
          if (next_step_options.includes(allowed_transition.next_state)) continue outterLoop;
          next_step_options.push(allowed_transition.next_state);
        }
      form.set_df_property("next_step", "options", next_step_options);
      async function OnClickValidate(dialog) {
        const serialNumberField = dialog.get_field("serialno_text-field");
        const serialNumbers = serialNumberField && typeof serialNumberField["get_value"] === "function" ? String(serialNumberField["get_value"]() || "").split("\n").map((sn) => sn.trim()).filter((sn) => sn !== "") : [];
        if (!serialNumbers || serialNumbers.length === 0) {
          frappe.msgprint("\u26A0\uFE0F Por favor, insira um n\xFAmero de s\xE9rie.");
          return;
        }
        const selectedState = form.doc.next_step;
        if (!selectedState) {
          frappe.msgprint("\u26A0\uFE0F Por favor, selecione o pr\xF3ximo passo do workflow.");
          return;
        }
        const modal = new agt.ui.UltraDialog({
          title: "Validando SN...",
          message: "",
          visible: false
        });
        modal.set_state("waiting");
        dialog.get_field("serialno_validate")["df"].disabled = 1;
        form.refresh();
        dialog.hide();
        dialog.clear();
        async function validateAndDisplayMessage(serialNumber) {
          const existingSn = form.doc.serial_no_table.some((child) => child.serial_no === serialNumber);
          if (existingSn) {
            return `<b>${serialNumber}:</b>\u274C Este n\xFAmero de s\xE9rie j\xE1 foi inserido.`;
          }
          let message = "";
          let modelInfo = "";
          let modelName = "";
          let companyName = "";
          let isValid = false;
          let outputInfo = "";
          if (!agt.growatt.sn_regex.test(serialNumber)) {
            message = `<b>${serialNumber}:</b>\u26A0\uFE0F N\xFAmero de s\xE9rie inv\xE1lido.`;
            outputInfo = OUTPUT_INFO_MESSAGE.SN_INVALID;
          } else {
            try {
              const { item, snInfo, printError } = await CheckSerialNumber(serialNumber);
              if (printError) {
                message = `<b>${serialNumber}: </b>\u274C ${printError}`;
                outputInfo = printError;
              } else if (!snInfo && !item) {
                message = `<b>${serialNumber}: </b>` + OUTPUT_INFO_MESSAGE.SN_NOT_FOUND;
                outputInfo = OUTPUT_INFO_MESSAGE.SN_NOT_FOUND;
              } else if (item && snInfo) {
                message = `<b>${serialNumber}: </b>` + OUTPUT_INFO_MESSAGE.SN_FOUND_ERP;
                outputInfo = OUTPUT_INFO_MESSAGE.SN_FOUND_ERP;
                if (snInfo && snInfo.item_code) {
                  modelInfo = snInfo.item_code;
                }
                if (snInfo && snInfo.item_name) {
                  modelName = snInfo.item_name;
                }
                if (snInfo && snInfo.company) {
                  companyName = snInfo.company;
                }
                isValid = true;
              } else if (item && !snInfo) {
                message = `<b>${serialNumber}:</b>\u2714\uFE0F SN encontrado na base da Growatt.`;
                outputInfo = OUTPUT_INFO_MESSAGE.SN_FOUND_GROWATT;
                modelInfo = item.item_code;
                modelName = item.item_name;
                isValid = true;
              }
              if (snInfo) {
                if (!sn_workflow) return frappe.throw("Workflow not found.");
                const available_transitions = sn_workflow.transitions.filter(
                  (transition) => transition.state === snInfo.workflow_state && transition.next_state === selectedState
                );
                if (!available_transitions.length && !is_force_state_allowed) {
                  const allowedStates = workflow_transitions.filter((t) => t.state === snInfo.workflow_state).map((t) => t.next_state).filter((value, index, self) => self.indexOf(value) === index);
                  message = `<b>${serialNumber}:</b>\u274C SN encontrado no ERP, mas a transi\xE7\xE3o de status \xE9 inv\xE1lida. <b>Estado atual: </b> ${snInfo.workflow_state}, <b>Pr\xF3ximo selecionado: </b> ${selectedState}. <b>Estado(s) permitido(s): </b> ${allowedStates.join(", ")}.`;
                  outputInfo = OUTPUT_INFO_MESSAGE.INVALID_WORKFLOW_TRANSITION;
                  isValid = false;
                }
              }
              const existingSn2 = form.doc.serial_no_table.some((child2) => child2.serial_no === serialNumber);
              if (existingSn2) {
                message = `<b>${serialNumber}:</b>\u274C Este n\xFAmero de s\xE9rie j\xE1 foi inserido.`;
                outputInfo = OUTPUT_INFO_MESSAGE.SN_DUPLICATED;
                isValid = false;
              }
              const existingEmptyRow = form.doc.serial_no_table.find((child2) => !child2.serial_no);
              const child = existingEmptyRow || frappe.model.add_child(form.doc, "serial_no_table");
              child.serial_no = serialNumber;
              child.item_code = modelInfo;
              child.item_name = modelName;
              child.company = companyName;
              child.next_step = selectedState;
              child.current_workflow_state = snInfo?.workflow_state || "";
              child.output_info = outputInfo;
              if (isValid) {
                child.is_valid = 1;
              } else {
                child.is_valid = 0;
              }
              form.refresh_field("serial_no_table");
            } catch (error) {
              console.error("Erro ao validar o n\xFAmero de s\xE9rie:", error);
              message = `<b>${serialNumber}:</b>\u274C Erro ao validar.`;
              outputInfo = "Erro ao validar.";
              const existingEmptyRow = form.doc.serial_no_table.find((child2) => !child2.serial_no);
              const child = existingEmptyRow || frappe.model.add_child(form.doc, "serial_no_table");
              child.serial_no = serialNumber;
              child.output_info = outputInfo;
              child.is_valid = 0;
              form.refresh_field("serial_no_table");
            }
          }
          if (modelInfo) {
            message += `(Eq: ${modelName}, C\xF3d: ${modelInfo})`;
          }
          return message;
        }
        try {
          for (const serialNumber of serialNumbers) {
            const msg = await validateAndDisplayMessage(serialNumber);
            modal.set_message(`${msg}`);
            modal.visible(true);
            modal.set_state("waiting");
          }
          modal.set_title("An\xE1lise Finalizada");
          modal.set_message("<div style='color:green;'>\u2714\uFE0F Processo finalizado!</div>");
          modal.set_state("default");
        } catch (error) {
          modal.set_title("An\xE1lise Finalizada");
          modal.set_message(`<div style='color:red;'>\u274C Erro geral: ${error}</div>`);
          modal.set_state("default");
        } finally {
          dialog.get_field("serialno_validate")["df"].disabled = 0;
          form.refresh();
        }
      }
      form.fields_dict["add_sn"]?.$wrapper?.off("click").on("click", () => {
        const diagTitle = "Adicionar SN";
        try {
          const dialog = agt.utils.dialog.load({
            title: diagTitle,
            fields: [
              {
                label: `<b>\u{1F4F7} Escanear c\xF3digo de barras</b><p><span class="text-muted small" style="font-size: 0.7em;">Clique para ativar o scanner de c\xF3digo de barras.</span></p>`,
                fieldname: "serialno_scan-barcode",
                fieldtype: "Button",
                reqd: false,
                click: () => {
                  try {
                    new frappe.ui.Scanner({
                      dialog: true,
                      multiple: false,
                      on_scan(data) {
                        if (data && data.result && data.result.text) {
                          const snField = dialog?.get_field("serialno_text-field");
                          const currentValue = String(snField?.["get_value"]() ?? "");
                          const newValue = currentValue ? currentValue + "\n" + data.result.text : data.result.text;
                          snField?.["set_input"](newValue);
                        }
                      }
                    });
                  } catch (scannerError) {
                    console.error("Error initializing scanner:", scannerError);
                    frappe.msgprint(__("N\xE3o foi poss\xEDvel iniciar o scanner. Verifique as permiss\xF5es da c\xE2mera ou se h\xE1 uma c\xE2mera dispon\xEDvel."));
                    frappe.show_alert({ message: "N\xE3o foi poss\xEDvel iniciar o scanner. Verifique as permiss\xF5es da c\xE2mera ou se h\xE1 uma c\xE2mera dispon\xEDvel.", indicator: "red" });
                  }
                }
              },
              {
                label: `<b>Serial Number</b>`,
                fieldname: "serialno_text-field",
                fieldtype: "Text",
                placeholder: "Insira o n\xFAmero de s\xE9rie manualmente ou escaneie o c\xF3digo de barras."
              },
              {
                label: "Validar",
                fieldname: "serialno_validate",
                fieldtype: "Button",
                reqd: false,
                primary: true,
                click: () => OnClickValidate(dialog)
              }
            ],
            static: false,
            lockClose: true,
            draggable: true
          });
        } catch (error) {
          console.error("Error creating or showing the 'Adicionar SN' dialog:", error);
          frappe.msgprint(__("Erro ao abrir a janela de adi\xE7\xE3o de SN. Verifique o console para detalhes."));
        }
      });
    }
  });
  agt.utils.dialog.close_all();
  async function CheckSerialNumber(sn) {
    let printError = "";
    const snInfo = await get_sn_info(sn);
    if (!snInfo || Object.keys(snInfo).length === 0) {
      const sn2 = await agt.utils.get_growatt_sn_info(sn);
      if (!sn2) {
        return { item: void 0, snInfo: void 0, printError };
      }
      const item = await agt.utils.get_item_info(sn2.data.model);
      return { item, snInfo: void 0, printError };
    }
    return { item: {}, snInfo, printError: "" };
  }
  async function get_sn_info(serialNumber) {
    return await frappe.db.get_value("Serial No", { serial_no: serialNumber }, ["workflow_state", "item_code", "item_name", "company"]).then((r) => r?.message || null);
  }
  frappe.ui.form.on("Serial No Workflow", {
    before_submit: async function(form) {
      await processSerialNumbers(form);
    },
    checkbox_force_state: function(frm) {
      const userHasPermission = allowedRoles.some((role) => frappe.boot.user.roles.includes(role));
      if (userHasPermission) {
        if (frm.doc.checkbox_force_state === 1) {
          is_force_state_allowed = true;
          frappe.show_alert({ message: __("For\xE7ar estado do Workflow <b>HABILITADO</b>."), indicator: "green" });
        } else {
          is_force_state_allowed = false;
          frappe.show_alert({ message: __("For\xE7ar estado do Workflow <b>DESABILITADO</b>."), indicator: "orange" });
        }
        console.log("is_force_state_allowed updated to:", is_force_state_allowed);
      } else {
        is_force_state_allowed = false;
        if (frm.doc.checkbox_force_state === 1) {
          frm.set_value("checkbox_force_state", 0);
          frappe.show_alert({ message: __("Voc\xEA n\xE3o tem permiss\xE3o para for\xE7ar o estado do Workflow."), indicator: "red" });
        }
      }
    }
  });
  async function processSerialNumbers(form) {
    const workflowDoc = await frappe.db.get_doc("Workflow", "workflow_serial_no");
    const initialState = workflowDoc.states?.[0]?.state;
    if (!initialState) {
      frappe.throw("Estado inicial do Workflow n\xE3o encontrado.");
    }
    const outputsMap = {
      [OUTPUT_INFO_MESSAGE.SN_FOUND_ERP]: true,
      [OUTPUT_INFO_MESSAGE.SN_FOUND_GROWATT]: true,
      [OUTPUT_INFO_MESSAGE.INVALID_WORKFLOW_TRANSITION]: !!form.doc.checkbox_force_state
    };
    const successfulSerialNumbers = form.doc.serial_no_table.filter((row) => outputsMap[row.output_info]);
    const allSerialNumbers = successfulSerialNumbers.map((row) => row.serial_no);
    const existingRecords = await frappe.db.get_list("Serial No", {
      fields: ["name", "workflow_state"],
      filters: { serial_no: ["in", allSerialNumbers] }
    });
    const existingSNSet = new Set(existingRecords.map((item) => item.name));
    const operations = [];
    for (const snRow of successfulSerialNumbers) {
      if (!snRow.serial_no || !snRow.next_step) {
        console.warn("Dados incompletos para o SN:", snRow);
        frappe.msgprint(`\u274C Dados incompletos para o SN ${snRow.serial_no}.`);
        throw "Processo abortado devido a dados incompletos.";
      }
      const currentState = snRow.current_workflow_state || initialState;
      let targetState;
      let isNew = false;
      if (!existingSNSet.has(snRow.serial_no)) {
        isNew = true;
        targetState = snRow.next_step;
      } else {
        const transition = workflowDoc.transitions.find(
          (t) => t.state === currentState && t.next_state === snRow.next_step
        );
        if (transition) {
          targetState = transition.next_state;
        } else if (is_force_state_allowed) {
          targetState = snRow.next_step;
        } else {
          const allowedStates = workflowDoc.transitions.filter((t) => t.state === currentState).map((t) => t.next_state).filter((value, index, self) => self.indexOf(value) === index);
          console.warn(`Transi\xE7\xE3o n\xE3o encontrada para SN existente ${snRow.serial_no}.`);
          frappe.msgprint(
            `\u274C Transi\xE7\xE3o de estado inv\xE1lida para SN: ${snRow.serial_no}. Estado atual: ${currentState}, Pr\xF3ximo selecionado: ${snRow.next_step}. Permitidos: ${allowedStates.join(", ")}.`
          );
          throw "Processo abortado devido a transi\xE7\xE3o inv\xE1lida para SN existente.";
        }
      }
      operations.push({
        sn: snRow.serial_no,
        isNew,
        targetState
      });
    }
    for (const op of operations) {
      if (op.isNew) {
        try {
          const correspondingRow = successfulSerialNumbers.find((row) => row.serial_no === op.sn);
          const newSN = await frappe.db.insert({
            doctype: "Serial No",
            serial_no: op.sn,
            item_code: correspondingRow?.item_code,
            item_name: correspondingRow?.item_name,
            company: correspondingRow?.company,
            workflow_state: initialState
            // Cria com o estado padrão do sistema.
          });
          if (newSN) {
            frappe.msgprint(`\u2714\uFE0F N\xFAmero de S\xE9rie ${op.sn} foi adicionado com sucesso ao banco de dados.`);
            form.doc.serial_no_table.filter((child) => child.serial_no === op.sn).forEach((child) => child.is_success = 1), form.refresh_field("serial_no_table");
            await agt.utils.update_workflow_state({
              doctype: "Serial No",
              docname: newSN.name,
              workflow_state: op.targetState,
              ignore_workflow_validation: true
            });
            console.log(`Workflow state atualizado para ${op.targetState} no novo SN ${op.sn}.`);
          }
        } catch (error) {
          console.error(`\u274C Erro ao adicionar o n\xFAmero de s\xE9rie ${op.sn}:`, error);
          frappe.msgprint(`\u274C Erro ao adicionar o n\xFAmero de s\xE9rie ${op.sn}.`);
          throw error;
        }
      } else {
        try {
          await agt.utils.update_workflow_state({
            doctype: "Serial No",
            docname: op.sn,
            workflow_state: op.targetState,
            ignore_workflow_validation: !!form.doc.checkbox_force_state
          });
          console.log(`Workflow state atualizado para ${op.targetState} no SN existente ${op.sn}.`);
        } catch (error) {
          console.error(`\u274C Erro ao atualizar workflow state do SN ${op.sn}:`, error);
          frappe.msgprint(`\u274C Falha ao atualizar workflow_state para ${op.targetState} no SN ${op.sn}.`);
          throw error;
        }
      }
    }
    form.refresh_field("serial_no_table");
  }
})();
